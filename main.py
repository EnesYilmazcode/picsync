from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse
import uvicorn
import os
import io
import base64
import re
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
import json
from dotenv import load_dotenv

# Google Cloud imports
from google.cloud import vision
from google.oauth2 import service_account
import google.generativeai as genai

# Load environment variables
load_dotenv()

app = FastAPI(title="PicSync", description="Convert screenshots to calendar invites")

# CORS middleware for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize Google Cloud Vision client
def get_vision_client():
    """Initialize Google Cloud Vision client with service account"""
    try:
        # Use the existing service account key
        credentials = service_account.Credentials.from_service_account_file(
            "functions/keys/vision-key.json"
        )
        return vision.ImageAnnotatorClient(credentials=credentials)
    except Exception as e:
        print(f"Error initializing Vision client: {e}")
        return None

# Initialize Gemini AI
def get_gemini_client():
    """Initialize Gemini AI client"""
    try:
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            print("Warning: GEMINI_API_KEY not found in environment variables")
            return None
        genai.configure(api_key=api_key)
        return genai.GenerativeModel('gemini-2.5-flash')
    except Exception as e:
        print(f"Error initializing Gemini client: {e}")
        return None

vision_client = get_vision_client()
gemini_client = get_gemini_client()

class CalendarEvent:
    """Class to represent a calendar event"""
    def __init__(self):
        self.title = ""
        self.date = ""
        self.time = ""
        self.location = ""
        self.description = ""
        self.duration = "1 hour"

def extract_text_from_image(image_data: bytes) -> str:
    """Extract text from image using Google Cloud Vision API"""
    if not vision_client:
        raise HTTPException(status_code=500, detail="Vision API not available")
    
    try:
        image = vision.Image(content=image_data)
        response = vision_client.text_detection(image=image)
        
        if response.error.message:
            raise HTTPException(status_code=500, detail=f"Vision API error: {response.error.message}")
        
        texts = response.text_annotations
        if texts:
            return texts[0].description
        return ""
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error processing image: {str(e)}")

def get_current_date_context():
    """Get current date context for Gemini to help with relative date parsing"""
    from datetime import datetime
    now = datetime.now()
    return f"Today is {now.strftime('%A, %B %d, %Y')} ({now.strftime('%m/%d/%Y')})"

def enhance_event_with_gemini(text: str, basic_event: CalendarEvent) -> CalendarEvent:
    """Use Gemini AI to enhance event parsing and generate better descriptions"""
    if not gemini_client:
        return basic_event
    
    try:
        prompt = f"""
Extract calendar event details from the text below.
Return ONLY one JSON object. Do not include prose or code fences.

TEXT:
{text}

CURRENT DATE: {get_current_date_context()}

RULES:
- title: main event name (room name, company info session, interview, meeting subject).
- date: MM/DD/YYYY format. CRITICAL: Look for actual dates in text like "Oct 3, 2025", "August 25, 1004", etc. Do NOT use CURRENT DATE unless no date is found.
- start_time: Extract START time from ranges like "2:30 PM to 4:00 PM" → "2:30 PM"
- end_time: Extract END time from ranges like "2:30 PM to 4:00 PM" → "4:00 PM"
- timezone: use explicit TZ if present, else 'America/New_York'.
- location: only if explicitly present (room, building, university, Zoom, etc.).
- description: 1–2 professional sentences summarizing purpose.
- duration: calculate from time range (e.g., "2:30 PM to 4:00 PM" = "1 hour 30 minutes").
- confidence: High, Medium, or Low based on clarity.

SCHEMA:
{{
  "title": string | null,
  "date": string | null,
  "start_time": string | null,
  "end_time": string | null,
  "timezone": string | null,
  "location": string | null,
  "description": string | null,
  "duration": string | null,
  "confidence": "High"|"Medium"|"Low"
}}
"""
        
        response = gemini_client.generate_content(prompt)
        
        # Parse the JSON response
        import json
        try:
            # Extract JSON from response text
            response_text = response.text.strip()
            
            if response_text.startswith('```json'):
                response_text = response_text[7:-3]
            elif response_text.startswith('```'):
                response_text = response_text[3:-3]
            
            gemini_data = json.loads(response_text)
            
            # Update event with Gemini's enhanced data
            enhanced_event = CalendarEvent()
            enhanced_event.title = gemini_data.get('title', basic_event.title) or basic_event.title
            enhanced_event.date = gemini_data.get('date', basic_event.date) or basic_event.date
            
            # Handle start_time/end_time or fall back to time
            start_time = gemini_data.get('start_time')
            end_time = gemini_data.get('end_time')
            if start_time:
                enhanced_event.time = start_time
            else:
                enhanced_event.time = gemini_data.get('time', basic_event.time) or basic_event.time
            
            enhanced_event.location = gemini_data.get('location', basic_event.location) or basic_event.location
            enhanced_event.description = gemini_data.get('description', basic_event.description) or basic_event.description
            enhanced_event.duration = gemini_data.get('duration', basic_event.duration) or basic_event.duration
            
            # Store the enhanced data for API response
            enhanced_event._gemini_data = gemini_data
            
            return enhanced_event
            
        except json.JSONDecodeError as e:
            print(f"Failed to parse Gemini JSON response: {e}")
            print(f"Raw response: {response_text}")
            return basic_event
            
    except Exception as e:
        print(f"Error with Gemini enhancement: {e}")
        return basic_event

def parse_event_from_text(text: str) -> CalendarEvent:
    """Parse calendar event information from extracted text with AI enhancement"""
    # First, do basic parsing as fallback
    event = CalendarEvent()
    
    # Clean up the text
    text = text.strip()
    lines = [line.strip() for line in text.split('\n') if line.strip()]
    
    # Patterns for different types of information
    date_patterns = [
        r'\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b',  # MM/DD/YYYY or MM-DD-YYYY
        r'\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{2,4})\b',  # DD Month YYYY
        r'\b((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[,\s]+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*)\b',  # Day, DD Month
    ]
    
    time_patterns = [
        r'\b(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))\b',  # 12:30 PM
        r'\b(\d{1,2}\s*(?:AM|PM|am|pm))\b',  # 12 PM
        r'\b(\d{1,2}:\d{2})\b',  # 24-hour format
    ]
    
    # Extract title (look for actual event content, not sender names)
    if lines:
        # Skip common email metadata patterns
        skip_patterns = [
            r'^[A-Za-z\s]+\s+(to|from)\s+me',  # "Mikayla Knotts to me"
            r'^[A-Za-z\s]+\s*$',  # Single names like "Mikayla Knotts"
            r'^(Re:|Fwd:|Subject:)',  # Email headers
            r'^\d{1,2}:\d{2}\s*(AM|PM)',  # Times like "10:48 AM"
        ]
        
        title_candidates = []
        for line in lines[:5]:  # Look at more lines
            if len(line) > 5 and not re.search(r'\d{1,2}[:/]\d{2}', line):
                # Skip if it matches email metadata patterns
                is_metadata = any(re.match(pattern, line, re.IGNORECASE) for pattern in skip_patterns)
                if not is_metadata:
                    title_candidates.append(line)
        
        # Look for lines that contain meeting/event keywords
        event_keywords = ['interview', 'meeting', 'call', 'session', 'appointment', 'conference', 'information session', 'info session', 'presentation', 'seminar', 'workshop']
        for candidate in title_candidates:
            if any(keyword in candidate.lower() for keyword in event_keywords):
                event.title = candidate
                break
        
        # Special handling for company information sessions
        if not event.title:
            for line in lines[:10]:  # Look through more lines
                if 'information session' in line.lower() or 'info session' in line.lower():
                    event.title = line
                    break
                elif '@' in line and any(word in line.lower() for word in ['university', 'college', 'school']):
                    event.title = line
                    break
        
        # If no event-specific title found, use first non-metadata line
        if not event.title and title_candidates:
            event.title = title_candidates[0]
        elif not event.title and lines:
            event.title = lines[0]
    
    # Extract date - look for structured formats first
    # Look for "Date: Oct 3, 2025" format first
    date_label_match = re.search(r'Date:\s*([A-Za-z]+ \d{1,2},? \d{4})', text, re.IGNORECASE)
    if date_label_match:
        event.date = date_label_match.group(1)
    else:
        # Fall back to general patterns
        for pattern in date_patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                event.date = match.group(1)
                break
    
    # Extract time - look for structured formats first
    # Look for "Time: 2:30 PM to 4:00 PM" format first
    time_label_match = re.search(r'Time:\s*(\d{1,2}:\d{2}\s*(?:AM|PM))', text, re.IGNORECASE)
    if time_label_match:
        event.time = time_label_match.group(1)
    else:
        # Fall back to general patterns
        for pattern in time_patterns:
            matches = re.findall(pattern, text, re.IGNORECASE)
            if matches:
                event.time = matches[0]
                break
    
    # Extract location (look for common location indicators)
    location_keywords = ['at ', 'location:', 'venue:', 'room ', 'building', 'address:', 'place:']
    for line in lines:
        line_lower = line.lower()
        for keyword in location_keywords:
            if keyword in line_lower:
                event.location = line
                break
        if event.location:
            break
    
    # Use remaining text as description
    description_lines = []
    for line in lines:
        # Skip lines that are already used for title, date, time, or location
        if (line != event.title and 
            not any(re.search(pattern, line, re.IGNORECASE) for pattern in date_patterns + time_patterns) and
            line != event.location):
            description_lines.append(line)
    
    event.description = '\n'.join(description_lines[:3])  # Limit description length
    
    # Enhance with Gemini AI if available
    enhanced_event = enhance_event_with_gemini(text, event)
    
    return enhanced_event

def create_google_calendar_url(event: CalendarEvent) -> str:
    """Create a Google Calendar URL for the event"""
    from urllib.parse import quote_plus
    import re
    from datetime import datetime, timedelta
    
    base_url = "https://calendar.google.com/calendar/render?action=TEMPLATE"
    
    # Format the event details for URL
    params = []
    
    if event.title:
        params.append(f"text={quote_plus(event.title)}")
    
    # Handle dates and times properly
    if event.date:
        try:
            # Get enhanced data if available
            enhanced_data = getattr(event, '_gemini_data', {})
            start_time = enhanced_data.get('start_time', event.time)
            end_time = enhanced_data.get('end_time')
            
            # Parse date (MM/DD/YYYY to YYYY-MM-DD)
            date_parts = event.date.split('/')
            if len(date_parts) == 3:
                month, day, year = date_parts
                iso_date = f"{year}-{month.zfill(2)}-{day.zfill(2)}"
                
                # Convert times to 24-hour format
                def convert_to_24h(time_str):
                    if not time_str:
                        return "12:00"
                    
                    # Clean the time string
                    time_str = time_str.strip()
                    
                    # Handle formats like "2:30 PM", "14:30", etc.
                    if 'PM' in time_str.upper():
                        time_part = time_str.upper().replace('PM', '').strip()
                        if ':' in time_part:
                            hours, minutes = time_part.split(':')
                            hours = int(hours)
                            if hours != 12:
                                hours += 12
                            return f"{hours:02d}:{minutes}"
                        else:
                            hours = int(time_part)
                            if hours != 12:
                                hours += 12
                            return f"{hours:02d}:00"
                    elif 'AM' in time_str.upper():
                        time_part = time_str.upper().replace('AM', '').strip()
                        if ':' in time_part:
                            hours, minutes = time_part.split(':')
                            hours = int(hours)
                            if hours == 12:
                                hours = 0
                            return f"{hours:02d}:{minutes}"
                        else:
                            hours = int(time_part)
                            if hours == 12:
                                hours = 0
                            return f"{hours:02d}:00"
                    else:
                        # Assume 24-hour format
                        if ':' in time_str:
                            return time_str
                        else:
                            return f"{time_str}:00"
                
                start_24h = convert_to_24h(start_time)
                
                # Calculate end time
                if end_time:
                    end_24h = convert_to_24h(end_time)
                else:
                    # Default to 1 hour later
                    start_hour, start_min = start_24h.split(':')
                    end_datetime = datetime.strptime(f"{start_hour}:{start_min}", "%H:%M") + timedelta(hours=1)
                    end_24h = end_datetime.strftime("%H:%M")
                
                # Format for Google Calendar (YYYYMMDDTHHMMSS)
                start_iso = f"{iso_date.replace('-', '')}T{start_24h.replace(':', '')}00"
                end_iso = f"{iso_date.replace('-', '')}T{end_24h.replace(':', '')}00"
                
                params.append(f"dates={start_iso}/{end_iso}")
            
        except Exception as e:
            print(f"Error formatting date/time: {e}")
            # Fallback to basic format
            if event.date:
                date_basic = event.date.replace('/', '')
                params.append(f"dates={date_basic}T120000/{date_basic}T130000")
    
    if event.location:
        params.append(f"location={quote_plus(event.location)}")
    
    if event.description:
        params.append(f"details={quote_plus(event.description)}")
    
    if params:
        return base_url + "&" + "&".join(params)
    return base_url

@app.get("/", response_class=HTMLResponse)
async def read_root():
    """Serve the main HTML page"""
    return FileResponse("static/index.html")

@app.post("/api/process-image")
async def process_image(file: UploadFile = File(...)):
    """Process uploaded image and extract calendar event information"""
    try:
        # Read image data
        image_data = await file.read()
        
        # Extract text using Vision API
        extracted_text = extract_text_from_image(image_data)
        
        if not extracted_text:
            raise HTTPException(status_code=400, detail="No text found in image")
        
        # Parse event information
        event = parse_event_from_text(extracted_text)
        
        # Create Google Calendar URL
        calendar_url = create_google_calendar_url(event)
        
        # Get enhanced data if available
        enhanced_data = getattr(event, '_gemini_data', {})
        
        return {
            "success": True,
            "extracted_text": extracted_text,
            "event": {
                "title": event.title,
                "date": event.date,
                "time": event.time,
                "start_time": enhanced_data.get('start_time', event.time),
                "end_time": enhanced_data.get('end_time'),
                "timezone": enhanced_data.get('timezone'),
                "location": event.location,
                "description": event.description,
                "duration": event.duration
            },
            "calendar_url": calendar_url
        }
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/process-clipboard")
async def process_clipboard(data: dict):
    """Process base64 encoded image from clipboard"""
    try:
        # Decode base64 image
        image_data_b64 = data.get("image", "")
        if not image_data_b64:
            raise HTTPException(status_code=400, detail="No image data provided")
        
        # Remove data URL prefix if present
        if "," in image_data_b64:
            image_data_b64 = image_data_b64.split(",")[1]
        
        image_data = base64.b64decode(image_data_b64)
        
        # Extract text using Vision API
        extracted_text = extract_text_from_image(image_data)
        
        if not extracted_text:
            raise HTTPException(status_code=400, detail="No text found in image")
        
        # Parse event information
        event = parse_event_from_text(extracted_text)
        
        # Create Google Calendar URL
        calendar_url = create_google_calendar_url(event)
        
        # Get enhanced data if available
        enhanced_data = getattr(event, '_gemini_data', {})
        
        return {
            "success": True,
            "extracted_text": extracted_text,
            "event": {
                "title": event.title,
                "date": event.date,
                "time": event.time,
                "start_time": enhanced_data.get('start_time', event.time),
                "end_time": enhanced_data.get('end_time'),
                "timezone": enhanced_data.get('timezone'),
                "location": event.location,
                "description": event.description,
                "duration": event.duration
            },
            "calendar_url": calendar_url
        }
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "vision_api": vision_client is not None}

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
