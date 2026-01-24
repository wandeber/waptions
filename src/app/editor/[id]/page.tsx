'use client';

import { useEffect, use, useRef } from 'react';
import { useProjectStore } from '@/stores/project-store';
import { Editor } from '@/components/video-editor/Editor';
import { useRouter } from 'next/navigation';

export default function EditorPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const { activeProject, loadProject } = useProjectStore();
    const router = useRouter();
    const lastLoadedId = useRef<string | null>(null);

    useEffect(() => {
        // Only load if we haven't loaded this ID yet AND we don't have it active
        if (id && lastLoadedId.current !== id) {
            if (!activeProject || activeProject.id !== id) {
                lastLoadedId.current = id;
                loadProject(id).catch(() => {
                    router.push('/');
                });
            } else {
                // Already have the correct project active (e.g. from createProject)
                lastLoadedId.current = id;
            }
        }
    }, [id, activeProject, loadProject, router]);

    return <Editor />;
}
