import React from 'react';
import ReactDOM from 'react-dom/client';
import TestRunner from './testDb';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TestRunner />
  </React.StrictMode>,
);
