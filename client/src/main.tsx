import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { registerSW } from './push';

void registerSW();

createRoot(document.getElementById('root')!).render(<App />);
