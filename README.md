# PicSync - Screenshot to Calendar

Transform event screenshots into Google Calendar invites instantly using AI.

## How It Works

Simple workflow:
1. **Upload** - User uploads a screenshot of an event
2. **Extract** - Google Cloud Vision API extracts text from the image
3. **Enhance** - Gemini AI validates and enhances event details (title, date, time, location, description)
4. **Generate** - Creates a Google Calendar link with all event details

## Architecture

- **Frontend**: Single HTML page (`public/index.html`)
- **Backend**: Firebase Cloud Functions (Node.js)
- **APIs**: Google Cloud Vision + Gemini AI

No complex backend server needed! Everything runs on Firebase.

## Setup

### 1. Install Dependencies

```bash
cd functions
npm install
```

### 2. Configure Gemini API Key (Required!)

**⚠️ Without this, Gemini AI won't work and event parsing will be inaccurate!**

1. Get your API key: https://aistudio.google.com/app/apikey
2. Create a `.env` file in the `functions/` directory:

```bash
# functions/.env
GEMINI_API_KEY=paste_your_actual_api_key_here
```

**Alternative:** Set it in Firebase config for production:
```bash
firebase functions:config:set gemini.api_key="your_gemini_api_key_here"
```

### 3. Google Cloud Vision Setup

Place your Vision API service account key at:
```
functions/keys/vision-key.json
```

### 4. Run Locally

```bash
firebase emulators:start
```

Then open: http://localhost:5000

### 5. Deploy to Firebase

```bash
firebase deploy
```

## Features

- 📸 **Drag & drop** or click to upload
- ⌨️ **Ctrl+V** to paste from clipboard
- 🤖 **AI-enhanced** parsing with Gemini
- 📅 **One-click** add to Google Calendar
- 📱 **Responsive** design
- ⚡ **Serverless** - no backend to manage

## File Structure

```
picsync/
├── public/
│   └── index.html          # Frontend UI
├── functions/
│   ├── index.js            # Firebase Cloud Functions
│   ├── keys/
│   │   └── vision-key.json # Google Cloud Vision credentials
│   └── package.json
├── firebase.json           # Firebase configuration
└── README.md
```

## API Endpoints

When deployed, Firebase automatically routes:

- `POST /api/process-image` → `parseImage` function (file upload)
- `POST /api/process-clipboard` → `visionOcr` function (clipboard paste)

## How Gemini Enhances Events

Gemini AI:
- Validates dates and converts to MM/DD/YYYY format
- Extracts start and end times from ranges
- Cleans up location names
- Generates professional descriptions
- Fills in missing details with smart assumptions
- Converts time formats and units

## License

MIT