'use client';

import { useEffect } from 'react';
import { useProjectStore } from '@/stores/project-store';
import { ProjectDashboard } from '@/components/dashboard/ProjectDashboard';

export default function Home() {
  const loadAllProjects = useProjectStore((state) => state.loadAllProjects);

  useEffect(() => {
    // Load projects on startup
    loadAllProjects();
  }, [loadAllProjects]);

  return <ProjectDashboard />;
}
