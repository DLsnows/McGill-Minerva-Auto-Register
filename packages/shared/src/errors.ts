/**
 * The page we got back is not a page we know how to read: the request itself
 * succeeded, but the expected result structure (table / caption / columns) was
 * not there.
 *
 * This is a statement about MINERVA'S HTML, never about the course. Callers
 * must not attribute it to "the CRN does not exist" (audit Q22) — a renamed
 * caption or a dropped column would otherwise look exactly like a bad CRN and
 * stop the target for the wrong reason.
 *
 * It lives in `shared` because it is part of the contract between the Minerva
 * adapters (which throw it) and the scheduler (which reacts to it).
 */
export class PageStructureError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PageStructureError';
  }
}
