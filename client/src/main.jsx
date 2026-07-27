import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom';
import { AppThemeProvider } from './context/ThemeContext';
import App from './App'

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
    <BrowserRouter>
        <AppThemeProvider>
            <App />
        </AppThemeProvider>
    </BrowserRouter>
);