import http.server
import socketserver
import webbrowser
import os
import json
import base64
import threading
import sys
import urllib.parse
import urllib.request
from datetime import datetime
from twilio.rest import Client

# Fix Unicode output on Windows console
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# Configuration
PORT = 8000
DIRECTORY = "web"
CAPTURES_DIR = "captures"

# Twilio Config — set these as environment variables before running:
#   set TWILIO_ACCOUNT_SID=your_account_sid
#   set TWILIO_AUTH_TOKEN=your_auth_token
#   set TWILIO_FROM_NUMBER=your_twilio_number
#   set POLICE_NUMBER=police_phone_number
#   set FAMILY_NUMBER=family_phone_number
TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID", "YOUR_TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN", "YOUR_TWILIO_AUTH_TOKEN")
TWILIO_FROM_NUMBER = os.environ.get("TWILIO_FROM_NUMBER", "+19783547672")
POLICE_NUMBER = os.environ.get("POLICE_NUMBER", "+917995723778")
FAMILY_NUMBER = os.environ.get("FAMILY_NUMBER", "+918919274810")

# Ensure captures directory exists
if not os.path.exists(CAPTURES_DIR):
    os.makedirs(CAPTURES_DIR)

# Store latest captured image path for MMS
latest_capture_path = None

def save_image_from_base64(data_url):
    """Save a base64 data URL image to the captures folder. Returns the file path."""
    global latest_capture_path
    try:
        # Remove data URL prefix (data:image/jpeg;base64,...)
        if ',' in data_url:
            header, encoded = data_url.split(',', 1)
        else:
            encoded = data_url
        
        image_data = base64.b64decode(encoded)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        filename = f"capture_{timestamp}.jpg"
        filepath = os.path.join(CAPTURES_DIR, filename)
        
        with open(filepath, 'wb') as f:
            f.write(image_data)
        
        latest_capture_path = filepath
        print(f"📸 Saved: {filepath}")
        return filepath
    except Exception as e:
        print(f"❌ Image save failed: {e}")
        return None

def upload_image(image_data):
    """Upload base64 image to free hosting and return public URL."""
    import requests
    try:
        if ',' in image_data:
            _, encoded = image_data.split(',', 1)
        else:
            encoded = image_data
        
        image_bytes = base64.b64decode(encoded)
        
        # Upload to 0x0.st (free, no API key needed)
        response = requests.post(
            'https://0x0.st',
            files={'file': ('driver_alert.jpg', image_bytes, 'image/jpeg')},
            timeout=15
        )
        
        if response.status_code == 200:
            url = response.text.strip()
            print(f"📤 Image uploaded: {url}")
            return url
    except Exception as e:
        print(f"⚠️ Image upload failed: {e}")
    
    return None

def send_sms(lat, lon, address="Unknown", image_data=None):
    """Send emergency SMS via Twilio with precise GPS location and image link."""
    try:
        client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
        map_link = f"https://www.google.com/maps?q={lat},{lon}"
        
        # Upload image if available
        image_url = None
        if image_data:
            print("📤 Uploading driver image...")
            image_url = upload_image(image_data)
        
        # Keep address short (max 60 chars)
        short_address = address[:60] if len(address) > 60 else address
        
        # Build message
        base_msg = (
            "drowsy device alert !!\n"
            "immediate assitance required\n"
            f"loc:{short_address}\n"
        )
        if image_url:
            base_msg += f"img : {image_url}\n"
        base_msg += f"loc:{map_link}"
        
        # Send to Police
        msg1 = client.messages.create(
            body=base_msg,
            from_=TWILIO_FROM_NUMBER,
            to=POLICE_NUMBER
        )
        print(f"✅ Police SMS sent! SID: {msg1.sid}")
        
        # Send to Family
        msg2 = client.messages.create(
            body=base_msg,
            from_=TWILIO_FROM_NUMBER,
            to=FAMILY_NUMBER
        )
        print(f"✅ Family SMS sent! SID: {msg2.sid}")
        
        return True, "SMS sent!"
    except Exception as e:
        error_msg = str(e)
        print(f"❌ SMS failed: {error_msg}")
        return False, error_msg


class APIHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)
    
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()
    
    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length)
        
        if self.path == '/api/send-sms':
            try:
                data = json.loads(post_data.decode('utf-8'))
                lat = data.get('lat', 0)
                lon = data.get('lon', 0)
                address = data.get('address', 'Unknown Location')
                image_data = data.get('image', None)
                
                print(f"\n{'='*50}")
                print(f"📍 Location: {lat}, {lon}")
                print(f"📍 Address: {address}")
                print(f"{'='*50}")
                
                # Run SMS in a thread so we don't block the response
                def sms_thread():
                    success, msg = send_sms(lat, lon, address, image_data)
                    if success:
                        print(f"✅ All messages sent successfully!")
                    else:
                        print(f"❌ SMS Error: {msg}")
                
                t = threading.Thread(target=sms_thread)
                t.start()
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                response = {'success': True, 'message': 'SMS sending in progress...'}
                self.wfile.write(json.dumps(response).encode())
                
            except Exception as e:
                print(f"❌ API error: {e}")
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'success': False, 'error': str(e)}).encode())
        
        elif self.path == '/api/save-image':
            try:
                data = json.loads(post_data.decode('utf-8'))
                image_data = data.get('image', '')
                photo_num = data.get('photoNum', 0)
                
                filepath = save_image_from_base64(image_data)
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                
                if filepath:
                    response = {'success': True, 'path': filepath}
                else:
                    response = {'success': False, 'error': 'Failed to save image'}
                self.wfile.write(json.dumps(response).encode())
                
            except Exception as e:
                print(f"❌ Save image error: {e}")
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'success': False, 'error': str(e)}).encode())
        
        else:
            self.send_response(404)
            self.end_headers()
    
    def do_GET(self):
        """Handle GET requests - intercept API routes, pass everything else to static file server."""
        if self.path.startswith('/api/tts'):
            try:
                # Parse query parameters
                query = urllib.parse.urlparse(self.path).query
                params = urllib.parse.parse_qs(query)
                text = params.get('text', [''])[0]
                lang = params.get('lang', ['en'])[0]
                
                if not text:
                    self.send_response(400)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({'error': 'No text provided'}).encode())
                    return
                
                # Build Google Translate TTS URL
                encoded_text = urllib.parse.quote(text)
                tts_url = f"https://translate.google.com/translate_tts?ie=UTF-8&q={encoded_text}&tl={lang}&client=tw-ob"
                
                # Fetch audio from Google TTS with browser-like headers
                req = urllib.request.Request(tts_url, headers={
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://translate.google.com/'
                })
                
                with urllib.request.urlopen(req, timeout=10) as response:
                    audio_data = response.read()
                
                self.send_response(200)
                self.send_header('Content-Type', 'audio/mpeg')
                self.send_header('Content-Length', str(len(audio_data)))
                self.send_header('Accept-Ranges', 'bytes')
                self.end_headers()
                self.wfile.write(audio_data)
                
            except Exception as e:
                print(f"TTS Proxy error: {e}")
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode())

        elif self.path.startswith('/api/geocode'):
            try:
                query = urllib.parse.urlparse(self.path).query
                params = urllib.parse.parse_qs(query)
                lat = params.get('lat', ['0'])[0]
                lon = params.get('lon', ['0'])[0]
                
                # Use Nominatim with proper User-Agent (required) and zoom=18 for building precision
                geo_url = f"https://nominatim.openstreetmap.org/reverse?format=json&lat={lat}&lon={lon}&zoom=18&addressdetails=1"
                req = urllib.request.Request(geo_url, headers={
                    'User-Agent': 'DriverDrowsinessDetectionSystem/1.0 (safety-project)',
                    'Accept-Language': 'en'
                })
                
                with urllib.request.urlopen(req, timeout=10) as response:
                    geo_data = json.loads(response.read().decode('utf-8'))
                
                # Build most precise address possible
                address_parts = []
                if 'address' in geo_data:
                    a = geo_data['address']
                    # Specific landmarks/buildings
                    for key in ['building', 'amenity', 'shop', 'office', 'tourism', 'leisure', 'university', 'college', 'school']:
                        if key in a:
                            address_parts.append(a[key])
                    # Road and locality
                    if 'road' in a: address_parts.append(a['road'])
                    if 'neighbourhood' in a: address_parts.append(a['neighbourhood'])
                    if 'suburb' in a: address_parts.append(a['suburb'])
                    city = a.get('city') or a.get('town') or a.get('village', '')
                    if city: address_parts.append(city)
                    if 'state' in a: address_parts.append(a['state'])
                
                if address_parts:
                    final_address = ', '.join(address_parts)
                else:
                    final_address = geo_data.get('display_name', f'{lat}, {lon}')
                
                print(f"📍 Geocoded: {final_address}")
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'address': final_address}).encode())
                
            except Exception as e:
                print(f"Geocode error: {e}")
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e), 'address': f'{lat}, {lon}'}).encode())
        
        else:
            # Serve static files normally
            super().do_GET()

def run_server():
    socketserver.TCPServer.allow_reuse_address = True
    
    try:
        with socketserver.TCPServer(("", PORT), APIHandler) as httpd:
            print(f"\n{'='*50}")
            print(f"  🚗 DRIVER DROWSINESS DETECTION SYSTEM")
            print(f"{'='*50}")
            print(f"  🌐 URL: http://localhost:{PORT}")
            print(f"  📱 Police: {POLICE_NUMBER}")
            print(f"  📱 Family: {FAMILY_NUMBER}")
            print(f"  📁 Captures: {os.path.abspath(CAPTURES_DIR)}")
            print(f"{'='*50}")
            print(f"  ⌨️  Press Ctrl+C to stop\n")
            
            webbrowser.open(f"http://localhost:{PORT}")
            httpd.serve_forever()
    except OSError as e:
        if e.errno in (48, 98, 10048):
            print(f"⚠️  Port {PORT} in use. Trying port {PORT+1}...")
            with socketserver.TCPServer(("", PORT+1), APIHandler) as httpd:
                print(f"✅ Running at: http://localhost:{PORT+1}")
                webbrowser.open(f"http://localhost:{PORT+1}")
                httpd.serve_forever()
        else:
            raise e
    except KeyboardInterrupt:
        print("\n🛑 Server stopped.")

if __name__ == "__main__":
    if not os.path.exists(DIRECTORY):
        print(f"❌ Error: '{DIRECTORY}' directory not found.")
    else:
        run_server()
