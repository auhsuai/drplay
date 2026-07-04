from http.server import BaseHTTPRequestHandler, HTTPServer
import sys

class S(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers['Content-Length'])
        print('RESULT:', self.rfile.read(length).decode('utf-8'))
        sys.stdout.flush()
        self.send_response(200)
        self.end_headers()

HTTPServer(('', 14231), S).handle_request()
