"""First-parent push-range discovery for non-primary repositories (docs/multi-repo.md).

Discovery keeps one pending `push-current` item per configured repo and
`reviewed_tip` state in the queue; `reviewed_tip` advances only when crq
harvests a counted review of the pinned range. The review unit reuses the
merged-current machinery (affected-current-additions projection, receipts,
pre-upload secret scan) with the source range generalized to (base, tip] and
the target pinned at capture time. The runner module is injected exactly like
repair_tick/backfill_runtime receive `c` — no import cycle, tests pass fakes.
"""
from pathlib import Path
import json
import re
from typing import Any, Dict, List, Optional, Tuple

import repo_registry
import review_receipt

KIND = "push-current"
POLICY = review_receipt.POLICY
# Shared caps (crq's per-file 256 KiB row-level unsupported stays; the 2 MiB
# review scope splits by path into follow-up parts instead of leaving overflow
# permanently unreviewed).
FILE_BYTES = 262144
SCOPE_BYTES = 2097152
SCOPE_CAP_REASON = "current content exceeds scope byte cap"


def part_id(cfg: Dict[str, Any], base: str, head: str, part: int = 1) -> str:
    """`push-<name>-<base>-<head>` (10-character shas, the house id style);
    overflow parts `…-p2`, `…-p3` (docs/multi-repo.md identity)."""
    stem = f"push-{cfg['name']}-{base[:10]}-{head[:10]}"
    return stem if part == 1 else f"{stem}-p{part}"


def _part_number(item_id: str) -> int:
    match = re.search(r"-p(\d+)$", item_id)
    return int(match.group(1)) if match else 1


def recover(runner, item_id: str, action: str, *, reason: str, verdict: str,
            operator: str) -> Dict[str, Any]:
    """Caller owns tick.lock. Retain the refused capture, never waive its scan.

    Recapture replaces the whole original range, including split overflow. A
    release only removes its lane pin: the next changed tip still owes review
    from reviewed_tip. Neither action claims a counted review or starts a CLI.
    """
    if action not in ("recapture", "release") or verdict not in ("false-positive", "source-fixed", "abandon"):
        raise ValueError("invalid push recovery action or verdict")
    if not reason.strip() or not operator.strip():
        raise ValueError("push recovery requires a reason and operator")
    q = runner.load_queue()
    item = next((i for i in runner.live_items(q) if i["id"] == item_id), None)
    if not item or item.get("kind") != KIND or item.get("state") != "blocked" or item.get("run"):
        raise ValueError("push recovery requires a scan-blocked, non-running push item")
    receipt_id = item.get("receipt_id")
    runner.review_receipt.read_receipt(runner.STATE / "receipts", receipt_id)
    document = json.loads((runner.STATE / "receipts" / (receipt_id + ".json")).read_text())
    if (document.get("outcome") != "blocked-secret-scan"
            or document.get("capture") != item.get("capture")
            or document.get("source") != item.get("subject")):
        raise ValueError("push recovery requires the matching blocked-secret-scan receipt")
    cfg = repo_registry.by_repo(runner.REPOS, runner.item_repo(item))
    if cfg is None:
        raise ValueError("push recovery repo is not configured")
    subject = item["subject"]
    # Retire only unstarted parts of this exact source range. Running or
    # previously dispatched work must be harvested, not overwritten by an op.
    family = [i for i in runner.live_items(q) if i.get("kind") == KIND
              and runner.item_repo(i) == cfg["repo"]
              and i["subject"]["base"] == subject["base"]
              and i["subject"]["head"] == subject["head"]
              and i.get("state") in ("pending", "blocked", "reviewing", "repairing")]
    if any(i.get("run") or i.get("attempts") or i.get("cycles")
           or i["state"] not in ("pending", "blocked") for i in family):
        raise ValueError("push recovery refuses dispatched range parts")
    if action == "release" and (subject.get("paths_filter") or item.get("depends_on")
                               or q.get("push_discovery", {}).get(cfg["repo"], {}).get("reviewed_tip") != subject["base"]):
        raise ValueError("release requires an unadvanced whole range; recapture split debt instead")
    record = {"at": runner.iso(), "action": action, "reason": reason.strip(),
              "verdict": verdict, "operator": operator.strip(), "receipt_id": receipt_id,
              "items": [i["id"] for i in family], "replacement": None}
    replacement = None
    if action == "recapture":
        clone = Path(cfg["clone"])
        runner.fetch(clone=clone,
                     refspec=f"+refs/heads/{cfg['default_branch']}:refs/remotes/origin/{cfg['default_branch']}")
        tip = runner.git("rev-parse", cfg["default_ref"] + "^{commit}", cwd=clone)
        if not runner.is_ancestor(subject["base"], tip, clone=clone):
            raise ValueError("push recovery refuses rewritten history")
        stem = part_id(cfg, subject["base"], tip)
        new_id = stem
        generation = 1
        used = {i["id"] for i in runner.live_items(q)}
        while new_id in used:
            new_id = f"{stem}-r{generation}"
            generation += 1
        replacement = _enroll(runner, q, cfg, subject["base"], tip, new_id, pin=tip)
        record["replacement"] = new_id
    for old in family:
        old["state"] = "skipped"
        old["push_recovery"] = dict(record)
        old.setdefault("notes", []).append(f"{record['at']} push recovery {action}: {reason.strip()}")
    if replacement is not None:
        replacement["recovered_from"] = item_id
        # Capture immediately under the same lock. prepare saves the complete
        # queue, including retired parts, but launch still owns the fresh scan.
        prepare(runner, q, replacement, False)
    runner.save_queue(q)
    runner.event("push_recovery", item=item_id, **record)
    runner.write_status(q)
    return {"version": 1, "item": item_id, "state": "skipped", **record}


def _enroll(runner, q, cfg: Dict[str, Any], base: str, head: str, item_id: str, *,
            depends_on: Optional[str] = None, paths_filter: Optional[List[str]] = None,
            pin: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Create one pending push item; ids are sticky, so an existing id is kept.

    The helper stamps `repo` so every new push item carries the field
    (docs/multi-repo.md migration: writers stamp, readers default)."""
    if any(i["id"] == item_id for i in runner.live_items(q)):
        return None
    item = {"id": item_id, "repo": cfg["repo"], "kind": KIND, "pr": 0,
            "subject": {"type": "push-range", "repo": cfg["repo"], "base": base, "head": head,
                        "policy": POLICY},
            "state": "pending", "created_at": runner.iso(), "order": runner.next_order(q),
            "cycles": [], "attempts": [], "failures": 0,
            "notes": [f"{runner.iso()} auto-enrolled: push range {base[:10]}..{head[:10]}"]}
    if depends_on:
        item["depends_on"] = depends_on
    if paths_filter:
        item["subject"]["paths_filter"] = sorted(set(paths_filter))
    if pin:
        # Follow-up parts review the content their parent deferred: pinning the
        # parent's capture target keeps that content from moving (or vanishing
        # from the filtered diff) before the part runs.
        item["subject"]["pin"] = pin
    q["items"].append(item)
    runner.event("enrolled", item=item_id, reason=item["notes"][0])
    return item


def discover(runner, q: Dict[str, Any], dry: bool) -> List[str]:
    """Per-repo first-parent range discovery. Never raises: one repo's broken
    clone skips that repo for this tick (docs/multi-repo.md push discovery)."""
    log: List[str] = []
    for cfg in runner.REPOS:
        if not cfg["push"]:
            continue
        try:
            log += _discover_repo(runner, q, cfg, dry)
        except Exception as exc:  # a broken repo must never halt the tick
            log.append(f"push discovery skipped {cfg['repo']}: {exc}"[:300])
    if not dry:
        runner.save_queue(q)
    return log


def _discover_repo(runner, q: Dict[str, Any], cfg: Dict[str, Any], dry: bool) -> List[str]:
    repo = cfg["repo"]
    clone = Path(cfg["clone"])
    try:
        # Forced refspec: a rewritten upstream branch must move the tracking ref,
        # otherwise rewritten history would be invisible to divergence detection.
        runner.fetch(clone=clone,
                     refspec=f"+refs/heads/{cfg['default_branch']}:refs/remotes/origin/{cfg['default_branch']}")
    except Exception as exc:
        return [f"push discovery skipped {repo}: fetch failed: {str(exc)[:200]}"]
    log: List[str] = []
    state = q.setdefault("push_discovery", {})
    record = state.setdefault(repo, {})
    tip = runner.git("rev-parse", cfg["default_ref"] + "^{commit}", cwd=clone)
    if not record.get("reviewed_tip"):
        # Floor initialization: the floor is the review boundary, never a debt.
        # A branch younger than the floor — or an unset floor — starts at its
        # tip and enrolls nothing (docs/multi-repo.md step 3).
        base = None
        if cfg["floor"]:
            # The reviewed range is first-parent history (docs/multi-repo.md):
            # a side-branch commit merged after the floor must not become the
            # boundary, or its additions would vanish from base..tip.
            base = runner.git("rev-list", "--first-parent", "-1",
                              f"--before={cfg['floor']}", cfg["default_ref"], cwd=clone)
        if dry:
            log.append(f"DRY-RUN would initialize {repo} reviewed tip {(base or tip)[:10]}; nothing enrolled")
            return log
        record["reviewed_tip"] = base or tip
        log.append(f"push discovery {repo}: initialized reviewed tip {record['reviewed_tip'][:10]}"
                   f"{'' if base else ' (branch younger than floor); nothing enrolled'}")
        return log
    reviewed = record["reviewed_tip"]
    if reviewed == tip:
        return log
    if not runner.is_ancestor(reviewed, tip, clone=clone):
        # Rewritten history is not reviewable as a range: reset without a review.
        if dry:
            log.append(f"DRY-RUN would reset {repo} reviewed tip to {tip[:10]} without review")
            return log
        record["reviewed_tip"] = tip
        runner.event("push_divergence", repo=repo, reviewed_tip=reviewed, tip=tip)
        log.append(f"push discovery {repo}: history rewritten ({reviewed[:10]} is not an ancestor of "
                   f"{tip[:10]}); reviewed tip reset without review")
        return log
    mine = [i for i in runner.live_items(q) if runner.item_repo(i) == repo and i.get("kind") == KIND]
    # Only an unfinished lane (captured pending/blocked, reviewing, repairing)
    # pins the range; done/terminal items keep their capture as history.
    live = [i for i in mine if i.get("state") in ("pending", "reviewing", "repairing", "blocked")]
    if any(i.get("capture") or i.get("state") in ("reviewing", "repairing") for i in live):
        # A captured/blocked or in-flight item pins its range until its harvest
        # advances reviewed_tip; the next range waits for it.
        log.append(f"push discovery {repo}: a captured push item pins the lane; next range waits")
        return log
    quiet = cfg["quiet_minutes"] or runner.CONFIG["quiet_minutes"]
    stamp = int(runner.git("show", "-s", "--format=%ct", tip, cwd=clone))
    age_min = (runner.time.time() - stamp) / 60
    if age_min < quiet:
        log.append(f"push discovery {repo}: tip {tip[:10]} is {age_min:.0f}m old (< {quiet}m quiet window)")
        return log
    item_id = part_id(cfg, reviewed, tip)
    if any(i["id"] == item_id and i["state"] == "pending" and not i.get("capture") for i in mine):
        # The same range is already enrolled and waiting for a start slot.
        # Coalescing it into itself would mark it skipped forever (and
        # enrollment refuses the id, since ids are sticky).
        log.append(f"push discovery {repo}: {item_id} already pending")
        return log
    if dry:
        log.append(f"DRY-RUN would enroll {item_id} ({reviewed[:10]}..{tip[:10]})")
        return log
    # Only whole-range items coalesce. Part items (-pN: paths_filter +
    # depends_on) are never candidates: skipping one would silently drop its
    # overflow scope from review, since a new range need not touch those paths.
    for old in (i for i in mine if i["state"] == "pending" and not i.get("capture")
                and not i["subject"].get("paths_filter") and not i.get("depends_on")):
        old["state"] = "skipped"
        old.setdefault("notes", []).append(f"{runner.iso()} coalesced into {item_id}")
        log.append(f"push discovery {repo}: coalesced {old['id']} into {item_id}")
    if _enroll(runner, q, cfg, reviewed, tip, item_id) is not None:
        log.append(f"push discovery {repo}: enrolled {item_id} ({reviewed[:10]}..{tip[:10]})")
    return log


def _split_scope(rows: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """First sorted candidate rows that fit the 2 MiB review scope, then overflow.

    current_paths marks cumulative-overflow rows "unsupported" with the scope-cap
    reason; for a push range those rows are split candidates (a size at or below
    the per-file cap distinguishes them from per-file over-cap rows), so every
    part stays a full review and none is silently dropped."""
    candidates = []
    for row in rows:
        if row.get("disposition") in ("included", "renamed"):
            candidates.append(row)
        elif (row.get("disposition") == "unsupported" and row.get("reason") == SCOPE_CAP_REASON
                and type(row.get("bytes")) is int and row["bytes"] <= FILE_BYTES):
            candidates.append(row)
    candidates.sort(key=lambda r: (r["path"], r["source_path"]))
    kept: List[Dict[str, Any]] = []
    overflow: List[Dict[str, Any]] = []
    total = 0
    for row in candidates:
        if total + row["bytes"] > SCOPE_BYTES:
            overflow.append(row)
        else:
            total += row["bytes"]
            kept.append(row)
    return kept, overflow


def prepare(runner, q: Dict[str, Any], item: Dict[str, Any], dry: bool) -> Optional[Dict[str, Any]]:
    """Capture/plan one push-current item, shaped like crq.prepare_current's plan.

    No cross-item receipt reuse scan in v1: discovery keeps a single live push
    item per repo, and each part (including follow-ups) is its own full review."""
    if dry:
        return {"base": "(dispatch-pin)", "head": "(dispatch-pin)", "target": item["subject"]["head"],
                "cycle": None, "branch": None, "label": "push range (not captured)", "notes": []}
    cfg = repo_registry.by_repo(runner.REPOS, runner.item_repo(item))
    if cfg is None:
        raise runner.NotReady(f"push item repo is not configured: {runner.item_repo(item)}")
    clone = Path(cfg["clone"])
    if not item.get("capture"):
        base = item["subject"]["base"]
        # Target is the repo's default branch pinned at capture time — or, for a
        # follow-up split part, exactly the parent capture's target, so the
        # deferred overflow content cannot move before this part reviews it.
        target = item["subject"].get("pin") or runner.git(
            "rev-parse", cfg["default_ref"] + "^{commit}", cwd=clone)
        if not runner.is_ancestor(base, target, clone=clone):
            raise runner.NotReady("push base is not an ancestor of the repository default branch")
        # The affected files of the whole range, resolved at the current target.
        rows = runner.current_paths(target, target, pre=base, clone=clone)
        if item["subject"].get("paths_filter"):
            wanted = set(item["subject"]["paths_filter"])
            rows = [r for r in rows if r["path"] in wanted]
        for row in rows:
            if not repo_registry.in_scope(cfg, row["path"]):
                row["disposition"] = "excluded-config"
                row["reason"] = f"excluded by repos config for {cfg['repo']}"
        kept, overflow = _split_scope(rows)
        for row in kept:
            if row["disposition"] not in ("included", "renamed"):
                # Rescued from current_paths' cumulative scope cap: this split
                # part reviews it, so it is selected scope again.
                row["disposition"] = "included"
        followup_id = None
        if overflow:
            n = _part_number(item["id"])
            followup_id = re.sub(r"-p\d+$", "", item["id"]) + f"-p{n + 1}"
            _enroll(runner, q, cfg, item["subject"]["base"], item["subject"]["head"], followup_id,
                    depends_on=item["id"], paths_filter=sorted({r["path"] for r in overflow}),
                    pin=target)
            for row in overflow:
                row["disposition"] = "deferred-split"
                row["reason"] = f"deferred to follow-up review {followup_id} (review scope cap)"
        capture = {"target": target, "tree": runner.git("rev-parse", target + "^{tree}", cwd=clone),
                   "paths": rows, "scope_digest": review_receipt.digest(rows),
                   "policy": review_receipt.POLICY,
                   "projection": "current-affected-files/full-file-addition-projection",
                   "reviewer": "coderabbit-review-agent-committed-v1",
                   "reviewer_version": runner.run(["coderabbit", "--version"]).stdout.strip()[:100],
                   "captured_at": runner.iso()}
        capture["equivalence"] = review_receipt.current_equivalence(capture)
        selected = sorted({r["path"] for r in kept})
        if selected:
            capture["base"], capture["head"] = runner.build_current_projection(target, selected, clone=clone)
            # Keep objects reachable through GC and daemon/caller restart.
            for part in ("base", "head"):
                runner.git("update-ref", f"refs/crq/current/{item['id']}/{part}", capture[part], cwd=clone)
        item["capture"] = capture
        runner.save_queue(q)
    capture = item["capture"]
    selected = [r for r in capture["paths"] if r["disposition"] in ("included", "renamed")]
    if not selected:
        unsupported = any(r["disposition"] in ("unsupported", "ambiguous") for r in capture["paths"])
        outcome = "unsupported" if unsupported else "no-current-code"
        item["receipt_id"] = review_receipt.write_receipt(runner.STATE / "receipts",
            runner.current_document(item, outcome))
        item["state"] = outcome
        runner.save_queue(q)
        return None
    return {"base": capture["base"], "head": capture["head"], "target": capture["target"],
            "review_pin": capture["target"], "cycle": None, "branch": None,
            "label": (f"push range {item['subject']['base'][:12]}..{item['subject']['head'][:12]} "
                      f"at {capture['target'][:12]}"), "notes": []}
