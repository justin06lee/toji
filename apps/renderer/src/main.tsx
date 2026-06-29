import '@fontsource/poppins/400.css';
import '@fontsource/poppins/500.css';
import '@fontsource/poppins/600.css';
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
