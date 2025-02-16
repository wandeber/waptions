import { StylePreset, eduSiverioPreset } from './types';

const STORAGE_KEY = 'waptions-style-presets';
const SELECTED_PRESET_KEY = 'waptions-selected-style-preset';

// Crear una copia del preset con un ID único para evitar duplicados en el render
const eduSiverioPresetWithUniqueId: StylePreset = {
  ...eduSiverioPreset,
  id: 'edu-siverio-default'
};

/**
 * Retrieves all style presets from localStorage
 */
export function getStylePresets(): StylePreset[] {
  if (typeof window === 'undefined') return [eduSiverioPresetWithUniqueId];
  
  try {
    const storedPresets = localStorage.getItem(STORAGE_KEY);
    const customPresets: StylePreset[] = storedPresets ? JSON.parse(storedPresets) : [];
    
    // Filtrar cualquier preset con isDefault que se haya guardado por error
    const validCustomPresets = customPresets.filter(p => !p.isDefault);
    
    // Si se encontraron presets con isDefault, limpiar el storage
    if (validCustomPresets.length !== customPresets.length) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(validCustomPresets));
    }
    
    return [eduSiverioPresetWithUniqueId, ...validCustomPresets];
  } catch (error) {
    console.error('Error loading style presets:', error);
    return [eduSiverioPresetWithUniqueId];
  }
}

/**
 * Saves a new style preset to localStorage
 */
export function saveStylePreset(name: string, style: StylePreset['style']): StylePreset {
  const storedPresets = localStorage.getItem(STORAGE_KEY);
  const customPresets: StylePreset[] = storedPresets ? JSON.parse(storedPresets) : [];
  
  const newPreset: StylePreset = {
    id: `preset-${Date.now()}`,
    name,
    style
  };
  
  customPresets.push(newPreset);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(customPresets));
  return newPreset;
}

/**
 * Deletes a style preset from localStorage
 */
export function deleteStylePreset(presetId: string): boolean {
  if (presetId === eduSiverioPresetWithUniqueId.id) return false;
  
  const storedPresets = localStorage.getItem(STORAGE_KEY);
  const customPresets: StylePreset[] = storedPresets ? JSON.parse(storedPresets) : [];
  const filteredPresets = customPresets.filter(p => p.id !== presetId);
  
  if (filteredPresets.length === customPresets.length) return false;
  
  localStorage.setItem(STORAGE_KEY, JSON.stringify(filteredPresets));
  return true;
}

/**
 * Updates an existing style preset in localStorage
 */
export function updateStylePreset(
  presetId: string, 
  updates: Partial<Omit<StylePreset, 'id' | 'isDefault'>>
): StylePreset | null {
  if (presetId === eduSiverioPresetWithUniqueId.id) return null;
  
  const storedPresets = localStorage.getItem(STORAGE_KEY);
  const customPresets: StylePreset[] = storedPresets ? JSON.parse(storedPresets) : [];
  const presetIndex = customPresets.findIndex(p => p.id === presetId);
  
  if (presetIndex === -1) return null;
  
  const updatedPreset = {
    ...customPresets[presetIndex],
    ...updates
  };
  
  customPresets[presetIndex] = updatedPreset;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(customPresets));
  return updatedPreset;
}

/**
 * Gets the currently selected preset and its style
 */
export function getSelectedPreset(): StylePreset | null {
  if (typeof window === 'undefined') return null;
  
  try {
    const savedPresetId = localStorage.getItem(SELECTED_PRESET_KEY);
    if (!savedPresetId) return null;

    // Si el ID guardado corresponde a cualquier versión del preset de Edu Siverio
    if (savedPresetId === eduSiverioPreset.id || savedPresetId === eduSiverioPresetWithUniqueId.id) {
      return eduSiverioPresetWithUniqueId;
    }

    // Obtener todos los presets y buscar en ellos
    const allPresets = getStylePresets();
    return allPresets.find(p => p.id === savedPresetId) || null;
  } catch (error) {
    console.error('Error loading selected preset:', error);
    return null;
  }
}