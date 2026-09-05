// Latin and Latin Extended subsets only. The default 400/500/600 entry points also pull
// in Devanagari, which nothing in the chrome renders — six font files nobody downloads.
import '@fontsource/poppins/latin-400.css';
import '@fontsource/poppins/latin-500.css';
import '@fontsource/poppins/latin-600.css';
import '@fontsource/poppins/latin-ext-400.css';
import '@fontsource/poppins/latin-ext-500.css';
import '@fontsource/poppins/latin-ext-600.css';
import { MotionConfig } from 'motion/react';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user" transition={{ type: 'spring', bounce: 0.18, visualDuration: 0.32 }}>
      <App />
    </MotionConfig>
  </React.StrictMode>
);
