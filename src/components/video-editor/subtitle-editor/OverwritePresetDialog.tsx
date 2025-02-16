import type { StylePreset } from './types';

interface OverwritePresetDialogProps {
  preset: StylePreset;
  onConfirm: () => void;
  onSaveAsCopy: () => void;
  onCancel: () => void;
}

export function OverwritePresetDialog({
  preset,
  onConfirm,
  onSaveAsCopy,
  onCancel
}: OverwritePresetDialogProps) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
        <h3 className="text-lg font-semibold text-white mb-4">
          Sobrescribir preset
        </h3>
        
        <p className="text-gray-300 mb-6">
          El preset &ldquo;{preset.name}&rdquo; ya existe. ¿Qué deseas hacer?
        </p>

        <div className="flex flex-col gap-3">
          <button
            onClick={onConfirm}
            className="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-500 
              transition-colors"
          >
            Sobrescribir
          </button>
          
          <button
            onClick={onSaveAsCopy}
            className="w-full px-4 py-2 bg-gray-700 text-white rounded hover:bg-gray-600 
              transition-colors"
          >
            Guardar como copia
          </button>
          
          <button
            onClick={onCancel}
            className="w-full px-4 py-2 bg-gray-700 text-white rounded hover:bg-gray-600 
              transition-colors"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
} 