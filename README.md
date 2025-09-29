# PicSync 📸➡️📅

Transform screenshots into Google Calendar invites instantly using AI-powered text recognition.

## Features

- 🖼️ **Drag & Drop Upload**: Simply drag your screenshot into the browser
- 📋 **Clipboard Support**: Paste images directly from your clipboard (Ctrl+V)
- 🤖 **AI-Powered**: Uses Google Cloud Vision API for accurate text extraction
- 📅 **Smart Parsing**: Automatically detects event details (title, date, time, location)
- 🔗 **One-Click Calendar**: Generate Google Calendar links instantly
- 📱 **Responsive Design**: Beautiful, modern UI that works on all devices
- ⚡ **Fast & Reliable**: Built with FastAPI and Firebase for optimal performance

## Tech Stack

- **Backend**: FastAPI (Python)
- **Frontend**: Vanilla HTML/CSS/JavaScript
- **AI/ML**: Google Cloud Vision API
- **Hosting**: Firebase Hosting + Functions
- **Deployment**: Firebase CLI

## Setup Instructions

### Prerequisites

1. **Node.js** (v18 or higher)
2. **Python** (v3.8 or higher)
3. **Firebase CLI**: `npm install -g firebase-tools`
4. **Google Cloud Project** with Vision API enabled
5. **Gemini AI API Key**: Get from [Google AI Studio](https://makersuite.google.com/app/apikey)

### Local Development

1. **Clone and navigate to the project**:
   ```bash
   cd picsync
   ```

2. **Set up environment variables**:
   ```bash
   # Create .env file for local development
   echo "GEMINI_API_KEY=your_gemini_api_key_here" > .env
   
   # For Firebase Functions, set the config
   firebase functions:config:set gemini.api_key="your_gemini_api_key_here"
   ```

3. **Install Python dependencies** (for local FastAPI development):
   ```bash
   pip install -r requirements.txt
   ```

4. **Install Firebase Functions dependencies**:
   ```bash
   cd functions
   npm install
   cd ..
   ```

5. **Start Firebase emulators**:
   ```bash
   firebase emulators:start
   ```

6. **Access the application**:
   - Frontend: http://localhost:5000
   - Functions: http://localhost:5001

### Alternative: Run FastAPI Directly

If you prefer to run the FastAPI server directly:

```bash
# Make sure you have a .env file with GEMINI_API_KEY
pip install -r requirements.txt
python main.py
```

Then visit http://localhost:8000

### Deployment

1. **Login to Firebase**:
   ```bash
   firebase login
   ```

2. **Deploy to Firebase**:
   ```bash
   firebase deploy
   ```

## Project Structure

```
picsync/
├── functions/                 # Firebase Functions
│   ├── keys/
│   │   └── vision-key.json   # Google Cloud service account key
│   ├── index.js              # Firebase Functions code
│   └── package.json          # Node.js dependencies
├── public/                   # Firebase Hosting files
│   └── index.html           # Frontend application
├── static/                  # FastAPI static files (for local dev)
│   └── index.html          # Same frontend for FastAPI
├── main.py                 # FastAPI application (alternative backend)
├── requirements.txt        # Python dependencies
├── firebase.json          # Firebase configuration
└── README.md             # This file
```

## API Endpoints

### Firebase Functions (Production)
- `POST /api/process-image` - Process uploaded image files
- `POST /api/process-clipboard` - Process base64 encoded clipboard images

### FastAPI (Local Development)
- `POST /api/process-image` - Process uploaded image files
- `POST /api/process-clipboard` - Process base64 encoded clipboard images
- `GET /health` - Health check endpoint

## Usage

1. **Upload Method**: Click "Upload Image" or drag & drop a screenshot
2. **Clipboard Method**: Click "Paste from Clipboard" or press Ctrl+V
3. **Review Results**: The AI will extract and parse event details
4. **Add to Calendar**: Click "Add to Google Calendar" to create the event

## Supported Image Formats

- PNG
- JPEG/JPG
- GIF
- WebP

## Event Detection

PicSync can automatically detect:
- **Event titles** (meeting names, event descriptions)
- **Dates** (various formats: MM/DD/YYYY, DD Month YYYY, etc.)
- **Times** (12-hour and 24-hour formats)
- **Locations** (addresses, room numbers, venue names)
- **Additional details** (descriptions, notes)

## Configuration

### Google Cloud Vision API

The application uses a service account key located at `functions/keys/vision-key.json`. Make sure this file contains valid credentials for a Google Cloud project with the Vision API enabled.

### Firebase Project

Update `.firebaserc` with your Firebase project ID:
```json
{
  "projects": {
    "default": "your-project-id"
  }
}
```

## Troubleshooting

### Common Issues

1. **Vision API Errors**: Ensure your service account key is valid and the Vision API is enabled
2. **CORS Issues**: Make sure Firebase Functions are properly configured with CORS headers
3. **File Upload Issues**: Check that the file size is under Firebase's limits (10MB for functions)

### Development Tips

- Use Firebase emulators for local development
- Check browser console for JavaScript errors
- Monitor Firebase Functions logs for backend issues
- Test with various screenshot formats and layouts

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

For issues and questions, please create an issue in the GitHub repository.
