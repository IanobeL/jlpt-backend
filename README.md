# jlpt-backend

Express + MongoDB Atlas API shared by the two JLPT KEBUN apps. It is the only component that holds database credentials; both frontends proxy `/api/*` here.

| Repo | Role |
|---|---|
| [jlpt-kebun](https://github.com/IanobeL/jlpt-kebun) | App ①: student mock test + teacher dashboard |
| [jlpt-mondai-sakusei](https://github.com/IanobeL/jlpt-mondai-sakusei) | App ②: question-bank CMS |
| **jlpt-backend** (this) | API on Railway |

Live: `https://jlpt-backend-production.up.railway.app` (quick check: `GET /api/packages`).

## Running

```
npm install
cp .env.example .env   # or create .env with the variables below
npm start              # node server.js
```

| Variable | Meaning |
|---|---|
| `MONGODB_URI` | Atlas connection string. Database `kebun_jlpt`, collections `questions_bank`, `histories`, `settings`, `packages`. |
| `GOOGLE_DRIVE_API_KEY` | For `/api/drive-media/:fileId`, which fetches question images and audio through the Drive API instead of hotlinking. |
| `PORT` | Defaults to 3001 locally; Railway injects its own. |

On Railway: rotating the Atlas password means updating the `MONGODB_URI` variable **and doing a full redeploy**. A plain restart reuses the old environment snapshot.

## Endpoints

Exam configuration and filters

| Method | Path | Notes |
|---|---|---|
| GET | `/api/exam-config` | Rules per subcategory. `?mode=test` (default) or `?mode=quiz`. |
| POST | `/api/save-config` | Same `?mode` switch. |
| GET | `/api/exam-config-version` | Cheap polling endpoint for App ①. |
| GET / POST | `/api/topic-filter`, `/api/save-topic-filter` | Shared on/off map per topic code. |

Packages

| Method | Path | Notes |
|---|---|---|
| GET | `/api/packages` | Registered packages unioned with every `packageId` found on questions. Shape `{success, packages:[{name,...}]}`. |
| POST / PUT / DELETE | `/api/packages`, `/api/packages/:name` | Create, rename or reweight, delete. |
| GET / POST | `/api/active-package`, `/api/set-active-package` | Only one package is active at a time. |

Questions

| Method | Path | Notes |
|---|---|---|
| GET | `/api/get-exam-questions?level=n3` | Bare array. `&mode=quiz` selects from the active package server-side and returns `409 {code:'no_active_package'}` when none is set. |
| GET | `/api/questions/browse?level=&subCategory=` | CMS browse. |
| POST | `/api/questions`, `/api/questions/bulk`, `/api/publish` | Insert. Every insert path runs `resolveTopicFields`, so send `topicCode`, not `topic`, when the value is a code. |
| PUT / DELETE | `/api/questions/:id` | Edit or remove one question. |
| POST | `/api/questions/assign-package`, `/api/questions/bulk-delete`, `/api/questions/bulk-update-fields` | Bulk operations. |
| GET / POST | `/api/questions/legacy-scan`, `/api/migrate-legacy/commit` | In-place migration of old documents missing `topicCode`. |

History and media

| Method | Path | Notes |
|---|---|---|
| POST | `/api/save-history` | Stores the attempt with a snapshot of the questions shown. |
| GET | `/api/get-history`, `/api/get-history/:id` | Paginated list and full record. |
| GET | `/api/drive-media/:fileId` | Streams Drive files with Range support and an in-memory LRU cache. |

## Error contract

App ① shows the `error` field of any non-2xx response to the student verbatim. So on every error status, `error` is a readable sentence and the machine-readable value goes in `code`.

## License

MIT.
