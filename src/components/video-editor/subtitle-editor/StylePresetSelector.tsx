import { useState, useEffect } from 'react';
import { ChevronDownIcon } from '../../icons/ChevronDownIcon';
import { TrashIcon } from '../../icons/TrashIcon';
import { SaveIcon } from '../../icons/SaveIcon';
import { PlusIcon } from '../../icons/PlusIcon';
import { Button } from '../../design-system/Button';
import type { StylePreset, SubtitleAnimationStyle } from './types';
import { 
  getStylePresets, 
  saveStylePreset, 
  deleteStylePreset,
  updateStylePreset 
} from './presetUtils';
import { OverwritePresetDialog } from './OverwritePresetDialog';
import { DeletePresetDialog } from './DeletePresetDialog';

const SELECTED_PRESET_KEY = 'waptions-selected-style-preset';

interface StylePresetSelectorProps {
  currentStyle: SubtitleAnimationStyle;
  onStyleChange: (style: SubtitleAnimationStyle) => void;
}

export function StylePresetSelector({ 
  currentStyle, 
  onStyleChange 
}: StylePresetSelectorProps) {
  const [presets, setPresets] = useState<StylePreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [newPresetName, setNewPresetName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [showOverwriteDialog, setShowOverwriteDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  useEffect(() => {
    // Asegurar que no hay duplicados en la lista de presets
    const allPresets = getStylePresets();
    const uniquePresets = allPresets.filter((preset, index, self) => 
      index === self.findIndex(p => p.id === preset.id)
    );
    setPresets(uniquePresets);

    // Recuperar el preset seleccionado del localStorage
    const savedPresetId = localStorage.getItem(SELECTED_PRESET_KEY);
    if (savedPresetId) {
      const preset = presets.find(p => p.id === savedPresetId);
      if (preset) {
        setSelectedPresetId(savedPresetId);
        onStyleChange(preset.style);
      }
    }
  }, []);

  const handlePresetSelect = (presetId: string) => {
    const preset = presets.find(p => p.id === presetId);
    if (preset) {
      setSelectedPresetId(presetId);
      onStyleChange(preset.style);
      // Guardar el preset seleccionado en localStorage
      localStorage.setItem(SELECTED_PRESET_KEY, presetId);
    }
  };

  const handleCreateNew = () => {
    setIsCreating(true);
    setNewPresetName('');
    setNameError(null);
  };

  const validatePresetName = (name: string): boolean => {
    if (!name.trim()) {
      setNameError('El nombre no puede estar vacío');
      return false;
    }

    if (presets.some(p => p.name.toLowerCase() === name.trim().toLowerCase())) {
      setNameError('Ya existe un preset con este nombre');
      return false;
    }

    setNameError(null);
    return true;
  };

  const handleSaveNew = () => {
    const trimmedName = newPresetName.trim();
    if (!validatePresetName(trimmedName)) return;
    
    const newPreset = saveStylePreset(trimmedName, currentStyle);
    setPresets(getStylePresets());
    setSelectedPresetId(newPreset.id);
    setNewPresetName('');
    setIsCreating(false);
  };

  const handleSave = () => {
    if (!selectedPresetId) return;

    const selectedPreset = presets.find(p => p.id === selectedPresetId);
    if (!selectedPreset) return;

    if (selectedPreset.isDefault) {
      // No permitir sobrescribir el preset predeterminado
      return;
    }

    setShowOverwriteDialog(true);
  };

  const handleOverwriteConfirm = () => {
    if (!selectedPresetId) return;

    updateStylePreset(selectedPresetId, { style: currentStyle });
    setPresets(getStylePresets());
    setShowOverwriteDialog(false);
  };

  const handleSaveAsCopy = () => {
    if (!selectedPresetId) return;

    const selectedPreset = presets.find(p => p.id === selectedPresetId);
    if (!selectedPreset) return;

    // Encontrar el siguiente número disponible para el sufijo
    const baseNameMatch = selectedPreset.name.match(/^(.*?)(?:\s*\(\d+\))?$/);
    const baseName = baseNameMatch?.[1] || selectedPreset.name;
    let counter = 1;
    let newName = `${baseName} (${counter})`;

    while (presets.some(p => p.name.toLowerCase() === newName.toLowerCase())) {
      counter++;
      newName = `${baseName} (${counter})`;
    }

    const newPreset = saveStylePreset(newName, currentStyle);
    setPresets(getStylePresets());
    setSelectedPresetId(newPreset.id);
    setShowOverwriteDialog(false);
  };

  const handleDeleteClick = () => {
    if (!selectedPresetId) return;
    setShowDeleteDialog(true);
  };

  const handleDeleteConfirm = () => {
    if (!selectedPresetId) return;

    if (deleteStylePreset(selectedPresetId)) {
      setPresets(getStylePresets());
      setSelectedPresetId(null);
      // Limpiar el preset seleccionado del localStorage
      localStorage.removeItem(SELECTED_PRESET_KEY);
    }
    setShowDeleteDialog(false);
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setNewPresetName(e.target.value);
    if (e.target.value.trim()) {
      validatePresetName(e.target.value);
    } else {
      setNameError(null);
    }
  };

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex justify-between items-center gap-2">
          <div className="relative flex-1 max-w-[300px]">
            <select
              value={selectedPresetId || ''}
              onChange={(e) => handlePresetSelect(e.target.value)}
              className="w-full bg-gray-700 text-white rounded p-1 text-sm appearance-none"
            >
              <option value="">Seleccionar preset...</option>
              {presets.map(preset => (
                <option key={preset.id} value={preset.id}>
                  {preset.name} {preset.isDefault ? '(predeterminado)' : ''}
                </option>
              ))}
            </select>
            <div className="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none text-gray-400">
              <ChevronDownIcon />
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleCreateNew}
              title="Nuevo preset"
            >
              <PlusIcon />
            </Button>

            <Button
              variant="secondary"
              size="sm"
              onClick={handleSave}
              disabled={!selectedPresetId || presets.find(p => p.id === selectedPresetId)?.isDefault}
              title="Guardar cambios"
            >
              <SaveIcon />
            </Button>

            {selectedPresetId && !presets.find(p => p.id === selectedPresetId)?.isDefault && (
              <Button
                variant="secondary"
                size="sm"
                onClick={handleDeleteClick}
                title="Eliminar preset"
              >
                <TrashIcon />
              </Button>
            )}
          </div>
        </div>

        {isCreating && (
          <div className="flex flex-col gap-2">
            <div className="flex gap-2 items-center">
              <input
                type="text"
                value={newPresetName}
                onChange={handleNameChange}
                placeholder="Nombre del nuevo preset..."
                className={`flex-1 bg-gray-700 rounded px-2 py-1.5 text-sm text-white
                  ${nameError ? 'border border-red-500' : ''}`}
                autoFocus
              />
              <Button
                variant="primary"
                size="sm"
                onClick={handleSaveNew}
                disabled={!newPresetName.trim() || !!nameError}
              >
                Guardar
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setIsCreating(false);
                  setNewPresetName('');
                  setNameError(null);
                }}
              >
                Cancelar
              </Button>
            </div>
            {nameError && (
              <span className="text-sm text-red-500">{nameError}</span>
            )}
          </div>
        )}
      </div>

      {showOverwriteDialog && selectedPresetId && (
        <OverwritePresetDialog
          preset={presets.find(p => p.id === selectedPresetId)!}
          onConfirm={handleOverwriteConfirm}
          onSaveAsCopy={handleSaveAsCopy}
          onCancel={() => setShowOverwriteDialog(false)}
        />
      )}

      {showDeleteDialog && selectedPresetId && (
        <DeletePresetDialog
          preset={presets.find(p => p.id === selectedPresetId)!}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setShowDeleteDialog(false)}
        />
      )}
    </>
  );
} 