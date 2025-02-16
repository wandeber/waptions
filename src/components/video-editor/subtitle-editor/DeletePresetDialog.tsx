import type { StylePreset } from './types';

interface DeletePresetDialogProps {
  preset: StylePreset;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeletePresetDialog({
  preset,
  onConfirm,
  onCancel
}: DeletePresetDialogProps) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
        <h3 className="text-lg font-semibold text-white mb-4">
          Eliminar preset
        </h3>
        
        <p className="text-gray-300 mb-6">
          ¿Estás seguro de que quieres eliminar el preset &ldquo;{preset.name}&rdquo;? 
          Esta acción no se puede deshacer.
        </p>

        <div className="flex flex-col gap-3">
          <button
            onClick={onConfirm}
            className="w-full px-4 py-2 bg-red-600 text-white rounded hover:bg-red-500 
              transition-colors"
          >
            Eliminar
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