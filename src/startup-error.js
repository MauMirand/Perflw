'use strict';
/* The message the student sees when Perflw cannot open, back up or update its databases at startup (PF-021).
   Pure: no Electron, no file access. main.js shows it and quits.

   Errors thrown by the migration runner (`src/db-migrate.js`) already say what happened, whether the data was
   changed and what to do, so they are kept as they are. Any other error (for example "file is not a database")
   gets a plain wrapper. Both end with the data folder, so the student knows where to look. */

const RUNNER_MESSAGE = /^Perflw could not (?:make a safety copy of|update) /;
const TITLE = 'Perflw could not start';

/* → { title, message }. `error` is whatever was thrown; `dataDir` is the data folder (userData). */
function startupMessage(error, { dataDir } = {}) {
  const raw = error && typeof error.message === 'string' && error.message.trim()
    ? error.message.trim() : 'An unknown error occurred.';
  const where = dataDir ? ` Your data folder is ${dataDir}.` : '';
  if (RUNNER_MESSAGE.test(raw)) return { title: TITLE, message: `${raw}${where}` };
  return {
    title: TITLE,
    message: 'Perflw could not open its data, so it did not start. Nothing was changed or deleted.'
      + `${where} If you have a recent copy of a database (a file ending in .bak-… next to it), you can close Perflw and copy it over the matching file to restore it. (${raw})`,
  };
}

module.exports = { startupMessage, TITLE };
