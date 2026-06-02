/** A user-specified course search target. */
export interface CourseQuery {
  /** 6-digit Minerva term code, e.g. "202701". */
  term: string;
  /** Subject code, e.g. "COMP". */
  subject: string;
  /** Course number, e.g. "551". */
  courseNumber: string;
  /** Optional faculty/college select value (sel_coll); omit to search all. */
  faculty?: string;
  /** The exact CRN to act on (a course may have multiple sections). */
  targetCrn: string;
}
