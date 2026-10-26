/** A database of its own, so the console's tests never race Graft's (`graft_test`). */
export const CONSOLE_TEST_DATABASE_URL =
  process.env.CONSOLE_TEST_DATABASE_URL ??
  "postgres://graft:graft@localhost:55432/graft_console_test";
