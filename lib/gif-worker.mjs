import { renderGIF } from './gif.mjs';
import { getSharp } from './render.mjs';

// These settings are local to this child process, leaving normal PNG rendering alone.
getSharp().cache(false);
getSharp().concurrency(1);
process.once('message', async project => {
  try {
    const bytes = await renderGIF(project);
    process.send({ bytes }, () => process.disconnect());
  } catch (error) {
    process.send({ error: error.message, status: error.status || (error.code ? 400 : 500) }, () => process.disconnect());
  }
});
