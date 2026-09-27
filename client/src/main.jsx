import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom';
import { AppThemeProvider } from './context/ThemeContext';
import ErrorBoundary from './components/ErrorBoundary';
import { initAnalytics } from './analytics';
import App from './App'

// Site Analytics: page views, clicks, errors and web vitals. See src/analytics/.
initAnalytics();

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
    <BrowserRouter>
        <AppThemeProvider>
            <ErrorBoundary>
                <App />
            </ErrorBoundary>
        </AppThemeProvider>
    </BrowserRouter>
);
