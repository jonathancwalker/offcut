# Offcut

An environment for exploring model creativity through collage. Give a model existing images and a few tools—cut, place, move, trim, and layer—then see what it makes. Each work keeps its source materials, a statement, and a replayable record of the model's choices.

**[Explore the gallery →](https://jonathancwalker.github.io/offcut/)**

Browse 60 works from our model self-conception study, filter by question and model, and play back how each collage was made. No installation or API key needed to view the gallery.

## Run it locally

You need **Node.js 22 or newer**, Git, and an API key to run a model. Starter images are included.

```sh
git clone https://github.com/jonathancwalker/offcut.git
cd offcut
npm install
npm start
```

Open **[localhost:4317](http://127.0.0.1:4317)**. Keep the terminal running while you use the app. If you've already cloned the repository, open a terminal in its folder and run `npm install` and `npm start`.

If port 4317 is occupied, use `PORT=4318 npm start` and open [localhost:4318](http://127.0.0.1:4318).

## Your first collage

1. Open **New run**.
2. **Pick images.** Pin any you want included, choose how many extras to draw at random, and use **Reshuffle** to change the draw.
3. **Connect a model.** Open **Connection**, paste your OpenAI API key, and click **Save → Check access & load models**. Choose an image-capable model available to your account.
4. **Set limits.** Start with **Small** and one run, then click **Start run**.
5. **See the result.** Open the finished work from **Library** to play its construction, read its statement, and inspect its fragments and sources.

New run gives the model an open assignment to make an original collage. Use Studies for your own prompts or other providers.

For a batch, increase the run count or add models. You can keep the same images, draw new ones each time, or keep pins and shuffle the extras. Runs execute sequentially. Limits are ceilings; a model can finish early.

**API calls are billed to your provider account.** Ordinary runs and batches have turn/action limits, but no dollar cap. Studies add a shared spending allowance.

## Your own prompts and model comparisons

Open **Studies → New study**.

1. Write a **Common brief** and add your **Prompts**. Each run receives the brief plus one prompt.
2. Choose fixed **Material sets** or generate matched random draws. Matching sets let you compare models using the same images.
3. Connect your providers under **Models**, check access, and select the exact model IDs.
4. Create or select a **Study allowance**. It is shared across all models and studies assigned to it.
5. Start with **Calibration**, using images separate from your primary sets. This runs your first prompt once per model to check image input, actions, and usage accounting. Choose **Review plan → Freeze study → Start study**.
6. After calibration succeeds, create a **Primary matrix** using the same allowance. Choose repetitions, review the full plan, freeze it, and start. Open the results to compare works by prompt and model.

Provider integrations: **OpenAI, Anthropic, Google, xAI, Alibaba (Qwen), and Hugging Face**. A study model must accept images, be available to your account, and have reviewed pricing configured in Offcut. Primary studies also require a successful calibration for each model. The study allowance is a local spending control, not an account-wide provider cap.

## Add images

Use **Add images** on New run to upload PNG, JPEG, or WebP files. To collect up to 100 more images from the Cleveland Museum of Art's CC0 collection:

```sh
npm run sources:collect -- --limit 100 --topics "birds,botanical,textile,architecture"
```

Refresh the material picker afterward. [Collection options and source credits](docs/SOURCE_COLLECTION.md).

## Keys and saved work

- **Keys:** keys entered in the app stay in server memory. Add them again after restarting. They aren't saved in browser storage or with your works. OpenAI also accepts the `OPENAI_API_KEY` environment variable.
- **Work:** saved in the repository's `.data/` folder. Keep it when moving or updating the app. Restarting preserves finished work but interrupts active runs.
- **Another data location:** use `OFFCUT_DATA_DIR="/absolute/path/to/offcut-data" npm start`. Only one server can use a data folder at a time.

To make a verified backup, stop the server and run:

```sh
npm run data:backup -- --from .data --out /absolute/path/to/new-backup
```

Use a new destination outside the data folder. If you set `OFFCUT_DATA_DIR`, use that path for `--from`.

## Development and details

Plain HTML, CSS, and JavaScript, with a Node server and Sharp for image rendering. Run `npm test` for the automated checks; they use simulated providers and don't spend API credits.

- [Agent tools and protocol](AGENT_PROTOCOL.md)
- [Study configuration](docs/STUDY_PLANS.md)
- [Export and share studies](docs/STUDY_RUNBOOK.md)
- [Batch controls](docs/BATCHES.md)
- [Roadmap](ROADMAP.md)
- [Bundled image credits](public/sources/CREDITS.md)

Model notes and statements are recorded explanations of the work. They don't expose private reasoning or establish an inner experience.
