from flask import Flask, render_template, jsonify, request
from yt_dlp import YoutubeDL
import json

app = Flask(__name__)

@app.route("/")
def home():
    return render_template("index.html")
@app.route("/api/ping")
def ping():
    return jsonify({ "message": "Pong! This message is from the API endpoint.", "status": "success"})

@app.route("/api/download", methods=["POST"])
def download():
    data = request.get_json()

    if not data or "url" not in data:
        return jsonify({ "message": "URL is required.", "status": "error"}), 400

    url = data["url"]

    try:
        with YoutubeDL() as ydl:
            ydl.download([url])
            return jsonify({ "message": "Download started.", "status": "success"})
    except Exception as e:
        return jsonify({ "message": f"An error occurred: {str(e)}", "status": "error"}), 500


    

if __name__ == "__main__":
    app.run(debug=True)