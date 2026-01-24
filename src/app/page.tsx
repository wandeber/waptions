'use client';

import { useEffect } from 'react';
import { useProjectStore } from '@/stores/project-store';
import { ProjectDashboard } from '@/components/dashboard/ProjectDashboard';

export default function Home() {
  const { loadAllProjects } = useProjectStore();

  useEffect(() => {
    // Load projects on startup
    loadAllProjects();
  }, [loadAllProjects]);

  return <ProjectDashboard />;
}
