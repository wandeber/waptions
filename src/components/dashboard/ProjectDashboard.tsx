'use client';

import { useState } from 'react';
import { useProjectStore } from '@/stores/project-store';
import { PlusIcon } from '../icons/PlusIcon';
import { TrashIcon } from '../icons/TrashIcon';
import { ConfirmDialog } from '../design-system/ConfirmDialog';

export function ProjectDashboard() {
    const { savedProjects, createProject, loadProject, deleteProject } = useProjectStore();
    const [isCreating, setIsCreating] = useState(false);
    const [newProjectName, setNewProjectName] = useState('');
    const [projectToDelete, setProjectToDelete] = useState<string | null>(null);

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newProjectName.trim()) return;

        setIsCreating(true);
        try {
            await createProject(newProjectName);
        } catch (error) {
            console.error(error);
            alert('Error al crear proyecto');
        } finally {
            setIsCreating(false);
            setNewProjectName('');
        }
    };

    const handleDelete = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        setProjectToDelete(id);
    };

    const handleConfirmDelete = async () => {
        if (projectToDelete) {
            await deleteProject(projectToDelete);
            setProjectToDelete(null);
        }
    };

    return (
        <div className="min-h-screen bg-gray-900 text-white p-8">
            <div className="max-w-6xl mx-auto space-y-8">

                {/* Header */}
                <div className="flex justify-between items-end border-b border-gray-800 pb-6">
                    <div>
                        <h1 className="text-3xl font-bold mb-2 bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">Waptions</h1>
                        <p className="text-gray-400">Gestiona tus proyectos de video</p>
                    </div>

                    <form onSubmit={handleCreate} className="flex gap-2">
                        <input
                            type="text"
                            placeholder="Nuevo proyecto..."
                            value={newProjectName}
                            onChange={(e) => setNewProjectName(e.target.value)}
                            className="bg-gray-800 border-gray-700 text-white rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-64"
                        />
                        <button
                            type="submit"
                            disabled={isCreating || !newProjectName.trim()}
                            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded flex items-center gap-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            <PlusIcon className="w-4 h-4" />
                            Crear
                        </button>
                    </form>
                </div>

                {/* Grid */}
                <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-6">
                    {savedProjects.length === 0 ? (
                        <div className="col-span-full py-20 text-center text-gray-500 border-2 border-dashed border-gray-800 rounded-xl">
                            <p>No tienes proyectos guardados.</p>
                            <p className="text-sm mt-2">Crea uno nuevo para empezar.</p>
                        </div>
                    ) : (
                        savedProjects.map((project) => (
                            <div
                                key={project.id}
                                onClick={() => loadProject(project.id)}
                                className="group bg-gray-800 border border-gray-700 rounded-xl overflow-hidden cursor-pointer hover:border-blue-500/50 hover:ring-2 hover:ring-blue-500/20 transition-all flex flex-col relative"
                            >
                                {/* Thumbnail Placeholder */}
                                <div className="aspect-video bg-gray-900 flex items-center justify-center text-gray-600 relative">
                                    {project.thumbnail ? (
                                        <img src={project.thumbnail} alt={project.name} className="w-full h-full object-cover" />
                                    ) : (
                                        <div className="text-4xl font-bold opacity-20 select-none">
                                            {project.name.substring(0, 2).toUpperCase()}
                                        </div>
                                    )}

                                    {/* Overlay Play Icon */}
                                    <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                                        <span className="bg-white/10 p-3 rounded-full backdrop-blur-sm">
                                            <span className="sr-only">Abrir</span>
                                            <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6 text-white">
                                                <path d="M8 5v14l11-7z" />
                                            </svg>
                                        </span>
                                    </div>
                                </div>

                                {/* Info */}
                                <div className="p-4 flex-1 flex flex-col justify-between">
                                    <div>
                                        <h3 className="font-medium text-lg text-gray-100 mb-1 truncate" title={project.name}>
                                            {project.name}
                                        </h3>
                                        <p className="text-xs text-gray-500">
                                            Editado: {project.updatedAt instanceof Date ? project.updatedAt.toLocaleDateString() : new Date(project.updatedAt).toLocaleDateString()}
                                        </p>
                                    </div>

                                    <div className="mt-4 flex justify-end">
                                        <button
                                            onClick={(e) => handleDelete(e, project.id)}
                                            className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors"
                                            title="Eliminar proyecto"
                                        >
                                            <TrashIcon className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>

            </div>

            <ConfirmDialog
                isOpen={!!projectToDelete}
                title="Eliminar proyecto"
                message={<>¿Estás seguro de que quieres eliminar este proyecto? Esta acción no se puede deshacer.</>}
                confirmLabel="Eliminar"
                cancelLabel="Cancelar"
                confirmVariant="danger"
                onConfirm={handleConfirmDelete}
                onCancel={() => setProjectToDelete(null)}
            />
        </div>
    );
}
