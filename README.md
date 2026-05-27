# AnkiDeckViewer Android App (Capacitor Scaffold)

## Requirements:
- Node.js (https://nodejs.org)
- Android Studio
- An Android device with AnkiDroid installed

## Setup Instructions:

1. Unzip this project.
2. Run the following commands in terminal:

   npm install --global @capacitor/cli
   npm init @capacitor/app
   (Choose 'None' for framework when prompted)

3. Replace the generated 'www/' folder with the one from this zip.

4. From the project root directory:

   npx cap add android
   npx cap copy
   npx cap open android

5. Android Studio will open. Click "Run" ▶️ to install on your phone.

6. On your phone:
   - Open AnkiDroid
   - Enable API access via Settings > Advanced > API
   - Restart AnkiDroid

## Notes:
- sql.js (WASM) placeholders included
- Integrate proper `sql.js` and deck parser to finalize
