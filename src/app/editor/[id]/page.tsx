'use client';

import { useEffect, use } from 'react';
import { useProjectStore } from '@/stores/project-store';
import { Editor } from '@/components/video-editor/Editor';
import { useRouter } from 'next/navigation';

export default function EditorPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const { activeProject, loadProject } = useProjectStore();
    const router = useRouter();

    useEffect(() => {
        if (!activeProject || activeProject.id !== id) {
            loadProject(id).catch(() => {
                // If it fails to load project, go back to dashboard
                router.push('/');
            });
        }
    }, [id, activeProject, loadProject, router]);

    return <Editor />;
}
