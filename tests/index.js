/**
 * The test files of this directory, loaded one after the other.
 *
 * Node 24 treats a directory given to `node --test` as a glob, so
 * `node --test tests/` tries to run the DIRECTORY as a file and fails with
 * "Cannot find module". This file makes that form work: Node loads it, and it
 * loads every test file, so the tests really run instead of being skipped.
 *
 * On an older Node the same command walks the directory and runs the
 * `*.test.mjs` files; this file is not part of that pattern, so nothing changes
 * there.
 */

import './goal.test.mjs';
import './series.test.mjs';
import './provider.test.mjs';
import './snap-click.test.mjs';
