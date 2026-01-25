"use client";

import Image from "next/image";
import { TrashIcon } from "../icons/TrashIcon";
import { Play } from "lucide-react";

interface Project {
    id: string;
    name: string;
    thumbnail?: string | null;
    duration?: number;
    updatedAt: Date | string | number;
}

interface ProjectCardProps {
    project: Project;
    onClick: () => void;
    onDelete: (e: React.MouseEvent) => void;
}

export function ProjectCard({ project, onClick, onDelete }: ProjectCardProps) {
    const formatDuration = (seconds?: number) => {
        if (seconds === undefined) return "--:--";
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, "0")}`;
    };

    const displayDate = project.updatedAt instanceof Date
        ? project.updatedAt.toLocaleDateString()
        : new Date(project.updatedAt).toLocaleDateString();

    return (
        <div
            onClick={onClick}
            className="group relative bg-gray-900/40 border border-gray-800/50 rounded-3xl overflow-hidden cursor-pointer hover:border-blue-500/30 hover:bg-gray-800/40 transition-all duration-500 flex flex-col backdrop-blur-xl shadow-2xl hover:shadow-blue-500/10 active:scale-[0.98]"
        >
            {/* Thumbnail Container */}
            <div className="aspect-video bg-gray-950/60 flex items-center justify-center text-gray-800 relative overflow-hidden border-b border-gray-800/50">
                {project.thumbnail ? (
                    <Image
                        src={project.thumbnail}
                        alt={project.name}
                        fill
                        unoptimized
                        className="object-cover transition-transform duration-700 group-hover:scale-110 group-hover:blur-[2px] opacity-80 group-hover:opacity-60"
                    />
                ) : (
                    <div className="text-6xl font-black opacity-5 select-none tracking-tighter italic">
                        {project.name.substring(0, 2).toUpperCase()}
                    </div>
                )}

                {/* Glass Overlay on Hover */}
                <div className="absolute inset-0 bg-gradient-to-t from-gray-950/90 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-all duration-300 flex items-center justify-center">
                    <div className="bg-white/10 p-4 rounded-full backdrop-blur-md border border-white/20 transform translate-y-8 group-hover:translate-y-0 transition-all duration-500 shadow-xl">
                        <Play className="w-6 h-6 text-white fill-white ml-0.5" />
                    </div>
                </div>

                {/* Duration Badge */}
                <div className="absolute bottom-3 right-3 px-2 py-1 rounded-lg bg-black/60 backdrop-blur-md text-[10px] font-bold text-gray-300 border border-white/10 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                    {formatDuration(project.duration)}
                </div>

                {/* Delete Button */}
                <button
                    onClick={onDelete}
                    className="absolute top-3 right-3 p-2 text-white/30 hover:text-red-400 bg-white/5 hover:bg-red-500/10 rounded-xl backdrop-blur-md opacity-0 group-hover:opacity-100 transition-all duration-300 border border-white/5 hover:border-red-500/20 z-10"
                    title="Eliminar proyecto"
                >
                    <TrashIcon className="w-4 h-4" />
                </button>
            </div>

            {/* Info section */}
            <div className="p-5 flex flex-col gap-1.5">
                <div className="flex justify-between items-start gap-3">
                    <h3 className="font-bold text-gray-100 truncate group-hover:text-blue-400 transition-colors text-base" title={project.name}>
                        {project.name}
                    </h3>
                </div>
                <div className="flex items-center gap-2">
                    <p className="text-[10px] uppercase tracking-[0.2em] text-gray-500 font-bold">
                        {displayDate}
                    </p>
                    <div className="w-1 h-1 rounded-full bg-gray-700" />
                    <p className="text-[10px] uppercase tracking-[0.2em] text-gray-500 font-bold">
                        Modified
                    </p>
                </div>
            </div>

            {/* Hover Shine Effect */}
            <div className="absolute inset-0 pointer-events-none bg-gradient-to-tr from-white/0 via-white/5 to-white/0 opacity-0 group-hover:opacity-100 transition-opacity duration-700 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-1000" />
        </div>
    );
}
