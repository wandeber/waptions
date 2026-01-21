'use client';

import { useEffect } from 'react';
import { useProjectStore } from '@/stores/project-store';
import { ProjectDashboard } from '@/components/dashboard/ProjectDashboard';
import { Editor } from '@/components/video-editor/Editor';

export default function Home() {
  const { activeProject, loadAllProjects, isLoading, isInitialized } = useProjectStore();

  useEffect(() => {
    // Load projects on startup
    loadAllProjects();
  }, [loadAllProjects]);

  // Loading state
  if (isLoading || !isInitialized) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-gray-900 text-gray-400 gap-2">
        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
        <span>Cargando Waptions...</span>
      </div>
    );
  }

  // If we have an active project, show the editor
  if (activeProject) {
    return <Editor />;
  }

  // Otherwise show the dashboard
  return <ProjectDashboard />;
}
