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

# Google Cloud imports
from google.cloud import vision
from google.oauth2 import service_account

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

vision_client = get_vision_client()

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

def parse_event_from_text(text: str) -> CalendarEvent:
    """Parse calendar event information from extracted text"""
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
    
    # Extract title (usually the first substantial line)
    if lines:
        # Look for the most substantial line as title
        title_candidates = [line for line in lines[:3] if len(line) > 5 and not re.search(r'\d{1,2}[:/]\d{2}', line)]
        if title_candidates:
            event.title = title_candidates[0]
        else:
            event.title = lines[0]
    
    # Extract date
    for pattern in date_patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            event.date = match.group(1)
            break
    
    # Extract time
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
    
    return event

def create_google_calendar_url(event: CalendarEvent) -> str:
    """Create a Google Calendar URL for the event"""
    base_url = "https://calendar.google.com/calendar/render?action=TEMPLATE"
    
    # Format the event details for URL
    params = []
    
    if event.title:
        params.append(f"text={event.title.replace(' ', '+')}")
    
    # Combine date and time for dates parameter
    if event.date and event.time:
        # This is a simplified approach - in production you'd want more robust date parsing
        params.append(f"dates={event.date.replace('/', '')}T{event.time.replace(':', '')}00/{event.date.replace('/', '')}T{event.time.replace(':', '')}00")
    elif event.date:
        params.append(f"dates={event.date.replace('/', '')}T120000/{event.date.replace('/', '')}T130000")
    
    if event.location:
        params.append(f"location={event.location.replace(' ', '+')}")
    
    if event.description:
        params.append(f"details={event.description.replace(' ', '+').replace('\n', '%0A')}")
    
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
        
        return {
            "success": True,
            "extracted_text": extracted_text,
            "event": {
                "title": event.title,
                "date": event.date,
                "time": event.time,
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
        
        return {
            "success": True,
            "extracted_text": extracted_text,
            "event": {
                "title": event.title,
                "date": event.date,
                "time": event.time,
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
