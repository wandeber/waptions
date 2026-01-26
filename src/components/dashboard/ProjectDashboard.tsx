import { useState, useMemo, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useProjectStore } from '@/stores/project-store';
import { PlusIcon } from '../icons/PlusIcon';
import { ConfirmDialog } from '../design-system/ConfirmDialog';
import { UserMenu } from './UserMenu';
import { SearchBar } from './SearchBar';
import { ProjectCard } from './ProjectCard';
import Image from 'next/image';
import { Sparkles, Database, Trash2, AlertCircle } from 'lucide-react';
import { storageService } from '@/lib/storage/storage-service';

export function ProjectDashboard() {
    const { savedProjects, createProject, deleteProject } = useProjectStore();
    const [searchQuery, setSearchQuery] = useState('');
    const [isCreating, setIsCreating] = useState(false);
    const [newProjectName, setNewProjectName] = useState('');
    const [projectToDelete, setProjectToDelete] = useState<string | null>(null);
    const [storageInfo, setStorageInfo] = useState<{ total: number, orphaned: { id: string, size: number }[] } | null>(null);
    const [isCleaning, setIsCleaning] = useState(false);
    const router = useRouter();

    const loadStorageInfo = useCallback(async () => {
        const total = await storageService.getTotalStorageSize();
        const orphaned = await storageService.getOrphanedDatabases();
        setStorageInfo({ total, orphaned });
    }, []);

    useEffect(() => {
        loadStorageInfo();
    }, [loadStorageInfo]);

    const handleCleanup = async () => {
        if (!storageInfo || storageInfo.orphaned.length === 0) return;
        setIsCleaning(true);
        try {
            for (const orphan of storageInfo.orphaned) {
                await storageService.deleteOrphanedData(orphan.id);
            }
            await loadStorageInfo();
        } catch (error) {
            console.error('Error cleaning up storage:', error);
        } finally {
            setIsCleaning(false);
        }
    };

    const formatBytes = (bytes: number) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const orphanedSize = useMemo(() => {
        return storageInfo?.orphaned.reduce((acc, curr) => acc + curr.size, 0) || 0;
    }, [storageInfo]);

    const filteredProjects = useMemo(() => {
        return savedProjects
            .filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase()))
            .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }, [savedProjects, searchQuery]);

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newProjectName.trim()) return;

        setIsCreating(true);
        try {
            const id = await createProject(newProjectName);
            router.push(`/editor/${id}`);
        } catch (error) {
            console.error(error);
            alert('Error al crear proyecto');
        } finally {
            setIsCreating(false);
            setNewProjectName('');
        }
    };

    const handleDelete = (e: React.MouseEvent, id: string) => {
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
        <div className="min-h-screen bg-gray-950 text-white selection:bg-blue-500/30 selection:text-blue-200 overflow-x-hidden relative">
            {/* Background Decorations */}
            <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none z-0">
                <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-600/10 blur-[120px] rounded-full" />
                <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-600/10 blur-[120px] rounded-full" />
            </div>

            <div className="max-w-7xl mx-auto px-6 py-12 space-y-12 relative z-10">
                {/* Header */}
                <header className="flex flex-col md:flex-row justify-between items-center gap-8 border-b border-gray-800/50 pb-10">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 relative rounded-2xl overflow-hidden shadow-lg shadow-blue-500/20 rotate-3 border border-white/10">
                            <Image
                                src="/logo.png"
                                alt="Waptions Logo"
                                fill
                                className="object-cover"
                            />
                        </div>
                        <div>
                            <h1 className="text-4xl font-black tracking-tight bg-gradient-to-r from-blue-100 via-white to-gray-400 bg-clip-text text-transparent">
                                Waptions
                            </h1>
                            <p className="text-gray-500 font-medium text-sm">Gestiona tus proyectos de video</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-6 w-full md:w-auto">
                        <SearchBar value={searchQuery} onChange={setSearchQuery} />
                        <div className="h-8 w-[1px] bg-gray-800 hidden md:block" />
                        <UserMenu />
                    </div>
                </header>

                {/* Hero / Create Section */}
                <section className="bg-gradient-to-br from-gray-900/50 to-gray-950/50 border border-gray-800/50 rounded-[2.5rem] p-8 md:p-12 backdrop-blur-md relative overflow-hidden group shadow-2xl">
                    <div className="relative z-10 flex flex-col md:flex-row items-center justify-between gap-8">
                        <div className="max-w-md text-center md:text-left">
                            <h2 className="text-2xl font-bold text-gray-100 mb-3">Empieza algo nuevo</h2>
                            <p className="text-gray-500 text-sm leading-relaxed">
                                Dale vida a tus videos con subtítulos dinámicos y premium. Crea tu próximo proyecto en segundos.
                            </p>
                        </div>
                        <form onSubmit={handleCreate} className="flex flex-col sm:flex-row gap-3 w-full md:w-auto">
                            <div className="relative">
                                <input
                                    type="text"
                                    placeholder="Nombre del proyecto..."
                                    value={newProjectName}
                                    onChange={(e) => setNewProjectName(e.target.value)}
                                    className="bg-gray-950/60 border border-gray-800 text-white rounded-2xl px-5 py-3.5 text-sm focus:outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500/50 w-full sm:w-72 transition-all placeholder:text-gray-600"
                                />
                            </div>
                            <button
                                type="submit"
                                disabled={isCreating || !newProjectName.trim()}
                                className="bg-blue-600 hover:bg-blue-500 text-white px-8 py-3.5 rounded-2xl flex items-center justify-center gap-2 text-sm font-bold transition-all shadow-lg shadow-blue-600/20 active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed group/btn"
                            >
                                <PlusIcon className="w-5 h-5 group-hover/btn:rotate-90 transition-transform duration-300" />
                                <span>Crear Proyecto</span>
                            </button>
                        </form>
                    </div>
                    {/* Animated Glow on Hover */}
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[120%] h-[120%] bg-blue-500/5 opacity-0 group-hover:opacity-100 transition-opacity duration-1000 blur-[100px] pointer-events-none" />
                </section>

                {/* Projects Grid */}
                <div className="space-y-6">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-2">
                        <h3 className="text-sm font-bold uppercase tracking-[0.2em] text-gray-500 flex items-center gap-2">
                            Tus Proyectos <span className="text-gray-700">/</span> <span className="text-blue-500/80">{filteredProjects.length}</span>
                        </h3>

                        <div className="flex flex-wrap items-center gap-3 text-[11px] font-semibold tracking-wide">
                            <div className="flex items-center gap-2 bg-gray-900/60 hover:bg-gray-900 px-3 py-1.5 rounded-xl border border-gray-800/50 transition-colors group">
                                <Database className="w-3.5 h-3.5 text-blue-500/70 group-hover:text-blue-400 transition-colors" />
                                <span className="text-gray-500 uppercase tracking-wider">Uso Total:</span>
                                <span className="text-blue-100/90">{formatBytes(storageInfo?.total || 0)}</span>
                            </div>

                            {orphanedSize > 0 && (
                                <div className="flex items-center gap-2 bg-amber-500/5 px-3 py-1.5 rounded-xl border border-amber-500/20 text-amber-200/80 animate-in fade-in slide-in-from-right-4 duration-500">
                                    <AlertCircle className="w-3.5 h-3.5 text-amber-500/70" />
                                    <span className="text-amber-500/70 uppercase tracking-wider">Huérfanos:</span>
                                    <span className="text-amber-100/90 font-bold">{formatBytes(orphanedSize)}</span>
                                    <div className="w-[1px] h-3 bg-amber-500/20 mx-1" />
                                    <button
                                        onClick={handleCleanup}
                                        disabled={isCleaning}
                                        className="flex items-center gap-1.5 text-amber-400 hover:text-amber-300 disabled:opacity-50 transition-colors transition-all active:scale-95 group"
                                    >
                                        <Trash2 className="w-3.5 h-3.5 group-hover:rotate-12 transition-transform" />
                                        <span className="underline underline-offset-4 decoration-amber-500/30">Limpiar ahora</span>
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                        {filteredProjects.length === 0 ? (
                            <div className="col-span-full py-24 text-center border-2 border-dashed border-gray-900 rounded-[2.5rem] bg-gray-900/10 backdrop-blur-sm group hover:border-blue-500/20 transition-colors">
                                <div className="w-16 h-16 bg-gray-900 rounded-2xl flex items-center justify-center mx-auto mb-6 group-hover:bg-blue-900/20 transition-colors">
                                    <Sparkles className="w-8 h-8 text-gray-600 group-hover:text-blue-500/50 transition-colors" />
                                </div>
                                <h4 className="text-xl font-bold text-gray-400 mb-2">
                                    {searchQuery ? 'No se encontraron resultados' : 'No tienes proyectos todavía'}
                                </h4>
                                <p className="text-sm text-gray-600 max-w-xs mx-auto">
                                    {searchQuery ? `Prueba con otra búsqueda o limpia el filtro.` : `¡Es un lienzo en blanco! Empieza creando tu primer proyecto arriba.`}
                                </p>
                            </div>
                        ) : (
                            filteredProjects.map((project) => (
                                <ProjectCard
                                    key={project.id}
                                    project={project}
                                    onClick={() => router.push(`/editor/${project.id}`)}
                                    onDelete={(e) => handleDelete(e, project.id)}
                                />
                            ))
                        )}
                    </div>
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

            <style jsx global>{`
                @keyframes float {
                    0% { transform: translateY(0px); }
                    50% { transform: translateY(-10px); }
                    100% { transform: translateY(0px); }
                }
            `}</style>
        </div>
    );
}
