import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { registerSW } from './push';
import { applyTheme, savedTheme } from './theme';

applyTheme(savedTheme());

void registerSW();

createRoot(document.getElementById('root')!).render(<App />);
