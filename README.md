# UConsulting Application Tracking System

A comprehensive application tracking system for UConsulting's recruitment process.

## Features

### Google Drive
- Contains the pre-ATS system for reference
- https://drive.google.com/drive/u/1/folders/1UMwhIFc0NXgGV52ZzqWn2qPLOdKrEys2

### Core Functionality
- **Application Management**: Track and review candidate applications
- **Review Teams**: Assign applications to review teams for evaluation
- **Cycle Management**: Manage recruiting cycles with start/end dates
- **Event Management**: Create and manage recruitment events with RSVP/attendance tracking
- **User Management**: Admin user management with role-based access
- **Interviews**: Schedule and manage interview rounds (Coffee Chat, Round 1, Round 2)

### Interview Management
The system now includes a comprehensive interview management feature that allows admins to:

- **Create Interview Events**: Schedule interviews for different rounds within a recruiting cycle
- **Interview Types**: Support for three interview types:
  - Coffee Chat Round
  - Round 1
  - Round 2
- **Interview Details**: Each interview can include:
  - Name and description
  - Start and end dates/times
  - Location (physical or virtual)
  - Maximum number of candidates
  - Associated recruiting cycle
- **Status Tracking**: Automatic status calculation (Upcoming, Active, Completed)
- **Visual Organization**: Separate sections for active/upcoming and past interviews

## Technology Stack

### Frontend
- React with Vite
- Material-UI (MUI) for components
- React Router for navigation
- Heroicons for icons

### Backend
- Node.js with Express
- Prisma ORM with PostgreSQL
- Supabase for authentication and database
- Google Drive API integration for file management

## Getting Started

### Prerequisites
- Node.js (v16 or higher)
- PostgreSQL database
- Supabase account

### Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   cd client && npm install
   cd ../server && npm install
   ```

3. Set up environment variables:
   - Copy `.env.example` to `.env` in the server directory
   - Configure your database and API keys

4. Run database migrations:
   ```bash
   cd server && npx prisma migrate deploy
   ```

5. Start the development servers:
   ```bash
   # Terminal 1 - Backend
   cd server && npm start
   
   # Terminal 2 - Frontend
   cd client && npm run dev
   ```

## Usage

### Admin Features
1. **Cycle Management**: Create and manage recruiting cycles
2. **Event Management**: Schedule events and track RSVPs/attendance
3. **Interview Management**: Create interview schedules for different rounds
4. **User Management**: Manage admin users and permissions
5. **Application Review**: Review and score candidate applications

### Interview Management Workflow
1. Navigate to the "Interviews" page (admin only)
2. Click "New Interview" to create an interview event
3. Fill in the required details:
   - Interview name
   - Type (Coffee Chat, Round 1, or Round 2)
   - Recruiting cycle
   - Start and end dates/times
   - Location and capacity
4. View and manage existing interviews in the organized sections

## API Endpoints

### Interview Management
- `GET /api/admin/interviews` - Get all interviews
- `POST /api/admin/interviews` - Create new interview
- `DELETE /api/admin/interviews/:id` - Delete interview

## Database Schema

The system includes a comprehensive database schema with models for:
- Users and authentication
- Candidates and applications
- Recruiting cycles
- Events and RSVPs
- Interviews
- Review teams and evaluations
- Grades and comments

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This project is proprietary to UConsulting.
