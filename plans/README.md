# Plans

- [Agent mechanical tooling](001-agent-mechanical-tooling.md): complete ESLint-to-Oxlint conversion, direct TS7 compiler ratchet with typed Oxlint, semantic checks and automatic formatting. Implementation and preflight complete; the documented direct-compiler fallback is active.
- [Test suite viability](002-test-suite-viability.md): shim our own logic through existing seams, keep one real contract per external boundary; sweep e2e and driver suites dominate (1344s baseline). Consensus with gpt-6-sol reached; implementation delegated.
