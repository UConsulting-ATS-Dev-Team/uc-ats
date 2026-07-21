import { GoogleAuth } from 'google-auth-library';
import config from '../../config.js';


const SCOPES = [
  'https://www.googleapis.com/auth/forms.responses.readonly',
  'https://www.googleapis.com/auth/forms.body.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar.events'
];

const auth = new GoogleAuth({
  keyFile: config.gCloudKeyPath,
  scopes: SCOPES,
});

let authClient;

// Get shared authenticated client for Google APIs
export async function getGoogleAuthClient() {
  if (!authClient) {
    authClient = await auth.getClient();
  }
  return authClient;
} 