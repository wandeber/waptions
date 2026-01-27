import { AlertTriangle } from 'lucide-react';
import { ConfirmDialog } from '@/components/design-system/ConfirmDialog';

interface ImportWarningDialogProps {
    isOpen: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}

export function ImportWarningDialog({ isOpen, onConfirm, onCancel }: ImportWarningDialogProps) {
    return (
        <ConfirmDialog
            isOpen={isOpen}
            title="Versión diferente"
            message={
                <div className="space-y-4">
                    <div className="flex items-center gap-3 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-amber-200/90">
                        <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
                        <p className="text-sm font-medium">
                            Este proyecto fue creado con una versión distinta de Waptions.
                        </p>
                    </div>
                    <p className="text-sm text-gray-400 leading-relaxed">
                        Es posible que algunas funciones o estilos no se comporten exactamente igual.
                        ¿Quieres continuar con la importación de todos modos?
                    </p>
                </div>
            }
            confirmLabel="Importar de todos modos"
            cancelLabel="Cancelar"
            confirmVariant="primary"
            onConfirm={onConfirm}
            onCancel={onCancel}
        />
    );
}
