const functions = require('firebase-functions');
const admin = require('firebase-admin');
const vision = require('@google-cloud/vision');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
try { require('dotenv').config(); } catch (e) { /* dotenv not installed; env fallback only */ }

// Initialize Firebase Admin
admin.initializeApp();

// Initialize Vision API client with service account
const visionClient = new vision.ImageAnnotatorClient({
  keyFilename: path.join(__dirname, 'keys', 'vision-key.json')
});

// Initialize Gemini AI
let geminiClient = null;
try {
  const geminiApiKey = process.env.GEMINI_API_KEY || (functions.config().gemini && functions.config().gemini.api_key);
  if (geminiApiKey) {
    const genAI = new GoogleGenerativeAI(geminiApiKey);
    // Use Gemini 2.5 Flash - fast and capable
    geminiClient = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash'
    });
  } else {
    console.warn('Gemini API key not found in Firebase config or environment (GEMINI_API_KEY). Falling back to basic parsing.');
  }
} catch (error) {
  console.error('Error initializing Gemini:', error);
}

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

function getCurrentDateContext() {
  const now = new Date();
  const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  const dateStr = now.toLocaleDateString('en-US', options);
  const shortDate = now.toLocaleDateString('en-US');
  return `Today is ${dateStr} (${shortDate})`;
}

async function enhanceEventWithGemini(text, basicEvent) {
  if (!geminiClient) {
    return basicEvent;
  }
  
  try {
    const prompt = `Extract calendar event details from the text below. Return ONLY one JSON object.\n\nTEXT:\n${text}\n\nCURRENT DATE: ${getCurrentDateContext()}\n\nRULES:\n- title: main event name (room name, company info session, interview, meeting subject).\n- date: ALWAYS use MM/DD/YYYY format. CRITICAL: Look for actual dates in text like "Oct 3, 2025", "August 25, 2024", "Sep 29, 2025", etc. Convert to MM/DD/YYYY (e.g., "Oct 3, 2025" → "10/03/2025", "Sep 29, 2025" → "09/29/2025"). Do NOT use CURRENT DATE unless no date is found.\n- start_time: Extract START time from ranges like "2:30 PM to 4:00 PM" → "2:30 PM". For single times like "8 PM", use as start time.\n- end_time: Extract END time from ranges like "2:30 PM to 4:00 PM" → "4:00 PM". If only start time given, calculate end time by adding duration.\n- timezone: use explicit TZ if present, else 'America/New_York'.\n- location: Extract ONLY the specific venue/building/room name. DO NOT include full addresses or long descriptions. For example: "Oldfield's Tavern" not long phrases.\n- description: 1–2 professional sentences summarizing purpose.\n- duration: calculate from time range or use "1 hour" as default.\n- confidence: High, Medium, or Low based on clarity.\n\nSCHEMA:{"title": null, "date": null, "start_time": null, "end_time": null, "timezone": null, "location": null, "description": null, "duration": null, "confidence": "High"}`;

    const result = await geminiClient.generateContent(prompt);
    const response = await result.response;

    // Parse the JSON response
    let responseText = '';
    try {
      responseText = response.text().trim();
      // When responseMimeType is JSON, it should be raw JSON; still handle code fences just in case
      if (responseText.startsWith('```json')) {
        responseText = responseText.slice(7, -3);
      } else if (responseText.startsWith('```')) {
        responseText = responseText.slice(3, -3);
      }

      const geminiData = JSON.parse(responseText);

      // Update event with Gemini's enhanced data
      const enhancedEvent = new CalendarEvent();
      enhancedEvent.title = geminiData.title || basicEvent.title;
      enhancedEvent.date = geminiData.date || basicEvent.date;

      // Handle start_time/end_time or fall back to time
      const startTime = geminiData.start_time;
      const endTime = geminiData.end_time;
      if (startTime) {
        enhancedEvent.time = startTime;
      } else {
        enhancedEvent.time = geminiData.time || basicEvent.time;
      }

      enhancedEvent.location = geminiData.location || basicEvent.location;
      enhancedEvent.description = geminiData.description || basicEvent.description;
      enhancedEvent.duration = geminiData.duration || basicEvent.duration;

      // Store the enhanced data for API response and diagnostics
      enhancedEvent._gemini_used = true;
      enhancedEvent._geminiData = geminiData;

      return enhancedEvent;
    } catch (jsonError) {
      console.error('Failed to parse Gemini JSON response:', jsonError);
      console.error('Raw response text:', responseText);
      return basicEvent;
    }
  } catch (error) {
    console.error('Error with Gemini enhancement:', error);
    return basicEvent;
  }
}

// Try to get a complete Google Calendar URL directly from Gemini
async function generateCalendarUrlWithGemini(rawText) {
  if (!geminiClient) return null;
  try {
    const prompt = `From the event text below, construct a Google Calendar template URL for a single event.\n\nREQUIREMENTS:\n- Use the 'render?action=TEMPLATE' URL form.\n- Include: text (title), details (1–2 sentences), dates (YYYYMMDDTHHMMSS/YYYYMMDDTHHMMSS), and ctz (timezone).\n- If end time missing, default to 1 hour after start.\n- If timezone missing, use America/New_York.\n- Encode characters as required by URL rules.\n\nReturn ONLY one JSON object with this shape: {"url": "https://calendar.google.com/calendar/render?action=TEMPLATE&..."}\n\nTEXT:\n${rawText}`;

    const result = await geminiClient.generateContent(prompt);
    const response = await result.response;
    let responseText = response.text().trim();
    if (responseText.startsWith('```json')) responseText = responseText.slice(7, -3);
    else if (responseText.startsWith('```')) responseText = responseText.slice(3, -3);
    const data = JSON.parse(responseText);
    const url = (data && data.url && String(data.url).trim()) || null;
    if (
      url &&
      url.startsWith('https://calendar.google.com/calendar/render?action=TEMPLATE') &&
      url.includes('dates=')
    ) {
      return url;
    }
  } catch (e) {
    console.error('Gemini direct URL generation failed:', e);
  }
  return null;
}

async function parseEventFromText(text) {
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
  
  // Enhance with Gemini AI if available
  const enhancedEvent = await enhanceEventWithGemini(text, event);
  
  return enhancedEvent;
}

function createGoogleCalendarUrl(event) {
  const baseUrl = "https://calendar.google.com/calendar/render?action=TEMPLATE";
  
  const params = [];
  
  if (event.title) {
    params.push(`text=${encodeURIComponent(event.title)}`);
  }
  
  // Handle dates and times properly
  if (event.date) {
    try {
      // Get enhanced data if available
      const enhancedData = event._geminiData || {};
      const startTime = enhancedData.start_time || event.time;
      const endTime = enhancedData.end_time;
      
      // Parse date - handle multiple formats
      let isoDate = null;
      
      // Try MM/DD/YYYY format first
      if (event.date.includes('/')) {
        const dateParts = event.date.split('/');
        if (dateParts.length === 3) {
          const [month, day, year] = dateParts;
          isoDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        }
      }
      // Try "Month DD, YYYY" format (e.g., "Oct 3, 2025")
      else if (event.date.includes(',')) {
        try {
          const parsedDate = new Date(event.date);
          if (!isNaN(parsedDate.getTime())) {
            isoDate = parsedDate.toISOString().split('T')[0];
          }
        } catch (error) {
          console.error('Error parsing date with comma:', error);
        }
      }
      // Try "Month DD YYYY" format (without comma)
      else {
        try {
          const parsedDate = new Date(event.date);
          if (!isNaN(parsedDate.getTime())) {
            isoDate = parsedDate.toISOString().split('T')[0];
          }
        } catch (error) {
          console.error('Error parsing date without comma:', error);
        }
      }
      
      if (isoDate) {
        // Convert times to 24-hour format
        function convertTo24h(timeStr) {
          if (!timeStr) return "12:00";
          
          // Clean the time string
          timeStr = timeStr.trim();
          
          // Handle formats like "2:30 PM", "14:30", etc.
          if (timeStr.toUpperCase().includes('PM')) {
            const timePart = timeStr.toUpperCase().replace('PM', '').trim();
            if (timePart.includes(':')) {
              const [hours, minutes] = timePart.split(':');
              let hour = parseInt(hours);
              if (hour !== 12) hour += 12;
              return `${hour.toString().padStart(2, '0')}:${minutes}`;
            } else {
              let hour = parseInt(timePart);
              if (hour !== 12) hour += 12;
              return `${hour.toString().padStart(2, '0')}:00`;
            }
          } else if (timeStr.toUpperCase().includes('AM')) {
            const timePart = timeStr.toUpperCase().replace('AM', '').trim();
            if (timePart.includes(':')) {
              const [hours, minutes] = timePart.split(':');
              let hour = parseInt(hours);
              if (hour === 12) hour = 0;
              return `${hour.toString().padStart(2, '0')}:${minutes}`;
            } else {
              let hour = parseInt(timePart);
              if (hour === 12) hour = 0;
              return `${hour.toString().padStart(2, '0')}:00`;
            }
          } else {
            // Assume 24-hour format
            if (timeStr.includes(':')) {
              return timeStr;
            } else {
              return `${timeStr}:00`;
            }
          }
        }
        
        const start24h = convertTo24h(startTime);
        
        // Calculate end time
        let end24h;
        if (endTime) {
          end24h = convertTo24h(endTime);
        } else {
          // Default to 1 hour later
          const [startHour, startMin] = start24h.split(':');
          const startDate = new Date();
          startDate.setHours(parseInt(startHour), parseInt(startMin));
          startDate.setHours(startDate.getHours() + 1);
          end24h = `${startDate.getHours().toString().padStart(2, '0')}:${startDate.getMinutes().toString().padStart(2, '0')}`;
        }
        
        // Format for Google Calendar (YYYYMMDDTHHMMSS)
        const startIso = `${isoDate.replace(/-/g, '')}T${start24h.replace(':', '')}00`;
        const endIso = `${isoDate.replace(/-/g, '')}T${end24h.replace(':', '')}00`;
        
        params.push(`dates=${startIso}/${endIso}`);
      } else {
        // If we couldn't parse the date, use current date as fallback
        const fallbackDate = new Date().toISOString().split('T')[0].replace(/-/g, '');
        params.push(`dates=${fallbackDate}T120000/${fallbackDate}T130000`);
      }
      
    } catch (error) {
      console.error('Error formatting date/time:', error);
      // Fallback to basic format
      if (event.date) {
        const dateBasic = event.date.replace(/\//g, '');
        params.push(`dates=${dateBasic}T120000/${dateBasic}T130000`);
      }
    }
  }
  
  if (event.location) {
    params.push(`location=${encodeURIComponent(event.location)}`);
  }
  
  if (event.description) {
    params.push(`details=${encodeURIComponent(event.description)}`);
  }
  
  // Add timezone - get from enhanced data or use default
  const enhancedData = event._geminiData || {};
  const timezone = enhancedData.timezone || 'America/New_York';
  params.push(`ctz=${encodeURIComponent(timezone)}`);
  
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
        const event = await parseEventFromText(extractedText);
        
        // Try Gemini direct URL first, fall back to builder
        let calendarUrl = await generateCalendarUrlWithGemini(extractedText);
        let calendarUrlSource = 'gemini-url';
        if (!calendarUrl) {
          calendarUrl = createGoogleCalendarUrl(event);
          calendarUrlSource = 'builder';
        }
        
        // Get enhanced data if available
        const enhancedData = event._geminiData || {};
        
        res.json({
          success: true,
          extracted_text: extractedText,
          event: {
            title: event.title,
            date: event.date,
            time: event.time,
            start_time: enhancedData.start_time || event.time,
            end_time: enhancedData.end_time,
            timezone: enhancedData.timezone,
            location: event.location,
            description: event.description,
            duration: event.duration
          },
          gemini_used: !!event._gemini_used,
          calendar_url_source: calendarUrlSource,
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
    const event = await parseEventFromText(extractedText);
    
    // Try Gemini direct URL first, fall back to builder
    let calendarUrl = await generateCalendarUrlWithGemini(extractedText);
    let calendarUrlSource = 'gemini-url';
    if (!calendarUrl) {
      calendarUrl = createGoogleCalendarUrl(event);
      calendarUrlSource = 'builder';
    }
    
    // Get enhanced data if available
    const enhancedData = event._geminiData || {};
    
    res.json({
      success: true,
      extracted_text: extractedText,
      event: {
        title: event.title,
        date: event.date,
        time: event.time,
        start_time: enhancedData.start_time || event.time,
        end_time: enhancedData.end_time,
        timezone: enhancedData.timezone,
        location: event.location,
        description: event.description,
        duration: event.duration
      },
      gemini_used: !!event._gemini_used,
      calendar_url_source: calendarUrlSource,
      calendar_url: calendarUrl
    });
    
  } catch (error) {
    console.error('Error in visionOcr function:', error);
    res.status(500).json({ error: 'Error processing image: ' + error.message });
  }
});
