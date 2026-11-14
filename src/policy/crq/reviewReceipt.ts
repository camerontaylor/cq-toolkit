/**
 * Local-review receipt bytes (`review_receipt.canonical` / `queue_transport`
 * result pages).
 *
 * The route only reads retained receipts; the runner that completes a review
 * writes them once by content identity. Chunks are digest-bound pages of the
 * canonical UTF-8 JSON bytes, so a client verifies the whole SHA-256 before
 * acknowledging.
 */
import { JsonNumber, JsonObject } from './jsonValue.js';
import { receiptJsonBytes, receiptJsonDigest, sha256Hex } from './pythonJson.js';
import { ValueError } from './reviewAdmission.js';

/** `review_receipt.CHUNK_BYTES`. */
export const REVIEW_CHUNK_BYTES = 3072;
/** `review_receipt.VERSION`. */
export const REVIEW_RECEIPT_VERSION = 1;

/** The canonical bytes and content identity of one receipt document. */
export function reviewReceiptBytes(document: unknown): {
  readonly data: Uint8Array;
  readonly receiptId: string;
} {
  const data = receiptJsonBytes(document);
  return { data, receiptId: sha256Hex(data) };
}

/** `review_receipt.digest`. */
export function reviewReceiptDigest(document: unknown): string {
  return receiptJsonDigest(document);
}

/**
 * One `result` page: `review_transport.handle`'s chunk object.
 *
 * `index` is zero-based; an out-of-bounds index is a caller error, not an
 * empty page. The chunk digest lets the client discard a mixed snapshot.
 */
export function reviewResultChunk(receiptId: string, data: Uint8Array, index: number): JsonObject {
  if (!/^[0-9a-f]{64}$/.test(receiptId)) throw new ValueError('invalid receipt id');
  if (!Number.isInteger(index) || index < 0) throw new ValueError('invalid result index');
  const count = Math.max(1, Math.ceil(data.length / REVIEW_CHUNK_BYTES));
  if (index >= count) throw new ValueError('result index out of bounds');
  const chunk = data.subarray(index * REVIEW_CHUNK_BYTES, (index + 1) * REVIEW_CHUNK_BYTES);
  return new JsonObject([
    ['v', JsonNumber.int(1)],
    ['receipt_id', receiptId],
    ['index', JsonNumber.int(index)],
    ['chunks', JsonNumber.int(count)],
    ['bytes', JsonNumber.int(data.length)],
    ['sha256', receiptId],
    ['encoding', 'base64-utf8-json'],
    ['data', Buffer.from(chunk).toString('base64')],
    ['chunk_sha256', sha256Hex(chunk)],
    ['next_index', index + 1 < count ? JsonNumber.int(index + 1) : null],
  ]);
}
