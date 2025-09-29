const functions = require('firebase-functions');
const admin = require('firebase-admin');
const vision = require('@google-cloud/vision');
const path = require('path');

// Initialize Firebase Admin
admin.initializeApp();

// Initialize Vision API client with service account
const visionClient = new vision.ImageAnnotatorClient({
  keyFilename: path.join(__dirname, 'keys', 'vision-key.json')
});

class CalendarEvent {
  constructor() {
    this.title = '';
    this.date = '';
    this.time = '';
    this.location = '';
    this.description = '';
    this.duration = '1 hour';
  }
}

function extractTextFromImage(imageData) {
  return new Promise(async (resolve, reject) => {
    try {
      const [result] = await visionClient.textDetection({
        image: { content: imageData }
      });
      
      const detections = result.textAnnotations;
      if (detections && detections.length > 0) {
        resolve(detections[0].description);
      } else {
        resolve('');
      }
    } catch (error) {
      reject(error);
    }
  });
}

function parseEventFromText(text) {
  const event = new CalendarEvent();
  
  // Clean up the text
  text = text.trim();
  const lines = text.split('\n').map(line => line.trim()).filter(line => line);
  
  // Patterns for different types of information
  const datePatterns = [
    /\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/,  // MM/DD/YYYY or MM-DD-YYYY
    /\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{2,4})\b/i,  // DD Month YYYY
    /\b((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[,\s]+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*)\b/i,  // Day, DD Month
  ];
  
  const timePatterns = [
    /\b(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))\b/,  // 12:30 PM
    /\b(\d{1,2}\s*(?:AM|PM|am|pm))\b/,  // 12 PM
    /\b(\d{1,2}:\d{2})\b/,  // 24-hour format
  ];
  
  // Extract title (usually the first substantial line)
  if (lines.length > 0) {
    // Look for the most substantial line as title
    const titleCandidates = lines.slice(0, 3).filter(line => 
      line.length > 5 && !/\d{1,2}[:/]\d{2}/.test(line)
    );
    if (titleCandidates.length > 0) {
      event.title = titleCandidates[0];
    } else {
      event.title = lines[0];
    }
  }
  
  // Extract date
  for (const pattern of datePatterns) {
    const match = text.match(pattern);
    if (match) {
      event.date = match[1];
      break;
    }
  }
  
  // Extract time
  for (const pattern of timePatterns) {
    const matches = text.match(pattern);
    if (matches) {
      event.time = matches[1];
      break;
    }
  }
  
  // Extract location (look for common location indicators)
  const locationKeywords = ['at ', 'location:', 'venue:', 'room ', 'building', 'address:', 'place:'];
  for (const line of lines) {
    const lineLower = line.toLowerCase();
    for (const keyword of locationKeywords) {
      if (lineLower.includes(keyword)) {
        event.location = line;
        break;
      }
    }
    if (event.location) break;
  }
  
  // Use remaining text as description
  const descriptionLines = [];
  for (const line of lines) {
    // Skip lines that are already used for title, date, time, or location
    if (line !== event.title && 
        !datePatterns.some(pattern => pattern.test(line)) &&
        !timePatterns.some(pattern => pattern.test(line)) &&
        line !== event.location) {
      descriptionLines.push(line);
    }
  }
  
  event.description = descriptionLines.slice(0, 3).join('\n');  // Limit description length
  
  return event;
}

function createGoogleCalendarUrl(event) {
  const baseUrl = "https://calendar.google.com/calendar/render?action=TEMPLATE";
  
  const params = [];
  
  if (event.title) {
    params.push(`text=${encodeURIComponent(event.title)}`);
  }
  
  // Combine date and time for dates parameter
  if (event.date && event.time) {
    // This is a simplified approach - in production you'd want more robust date parsing
    const dateStr = event.date.replace(/[/-]/g, '');
    const timeStr = event.time.replace(/[:\s]/g, '').replace(/[APM]/gi, '');
    params.push(`dates=${dateStr}T${timeStr}00/${dateStr}T${timeStr}00`);
  } else if (event.date) {
    const dateStr = event.date.replace(/[/-]/g, '');
    params.push(`dates=${dateStr}T120000/${dateStr}T130000`);
  }
  
  if (event.location) {
    params.push(`location=${encodeURIComponent(event.location)}`);
  }
  
  if (event.description) {
    params.push(`details=${encodeURIComponent(event.description)}`);
  }
  
  if (params.length > 0) {
    return baseUrl + "&" + params.join("&");
  }
  return baseUrl;
}

// Firebase Function to process uploaded images
exports.parseImage = functions.https.onRequest(async (req, res) => {
  // Set CORS headers
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  
  try {
    // Handle multipart form data (file upload)
    const busboy = require('busboy');
    const bb = busboy({ headers: req.headers });
    
    let imageData = null;
    
    bb.on('file', (fieldname, file, info) => {
      const chunks = [];
      file.on('data', (chunk) => {
        chunks.push(chunk);
      });
      file.on('end', () => {
        imageData = Buffer.concat(chunks);
      });
    });
    
    bb.on('finish', async () => {
      try {
        if (!imageData) {
          res.status(400).json({ error: 'No image data received' });
          return;
        }
        
        // Extract text using Vision API
        const extractedText = await extractTextFromImage(imageData);
        
        if (!extractedText) {
          res.status(400).json({ error: 'No text found in image' });
          return;
        }
        
        // Parse event information
        const event = parseEventFromText(extractedText);
        
        // Create Google Calendar URL
        const calendarUrl = createGoogleCalendarUrl(event);
        
        res.json({
          success: true,
          extracted_text: extractedText,
          event: {
            title: event.title,
            date: event.date,
            time: event.time,
            location: event.location,
            description: event.description,
            duration: event.duration
          },
          calendar_url: calendarUrl
        });
        
      } catch (error) {
        console.error('Error processing image:', error);
        res.status(500).json({ error: 'Error processing image: ' + error.message });
      }
    });
    
    bb.end(req.rawBody);
    
  } catch (error) {
    console.error('Error in parseImage function:', error);
    res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// Firebase Function to process clipboard images
exports.visionOcr = functions.https.onRequest(async (req, res) => {
  // Set CORS headers
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  
  try {
    const { image } = req.body;
    
    if (!image) {
      res.status(400).json({ error: 'No image data provided' });
      return;
    }
    
    // Decode base64 image
    let imageDataB64 = image;
    if (imageDataB64.includes(',')) {
      imageDataB64 = imageDataB64.split(',')[1];
    }
    
    const imageData = Buffer.from(imageDataB64, 'base64');
    
    // Extract text using Vision API
    const extractedText = await extractTextFromImage(imageData);
    
    if (!extractedText) {
      res.status(400).json({ error: 'No text found in image' });
      return;
    }
    
    // Parse event information
    const event = parseEventFromText(extractedText);
    
    // Create Google Calendar URL
    const calendarUrl = createGoogleCalendarUrl(event);
    
    res.json({
      success: true,
      extracted_text: extractedText,
      event: {
        title: event.title,
        date: event.date,
        time: event.time,
        location: event.location,
        description: event.description,
        duration: event.duration
      },
      calendar_url: calendarUrl
    });
    
  } catch (error) {
    console.error('Error in visionOcr function:', error);
    res.status(500).json({ error: 'Error processing image: ' + error.message });
  }
});
