'use client';

import { use } from 'react';
import { useProjectStore } from '@/stores/project-store';
import { Editor } from '@/components/video-editor/Editor';
import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { useEditorProjectRoute } from '@/hooks/use-editor-project-route';

export default function EditorPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const activeProjectId = useProjectStore((state) => state.activeProject?.id ?? null);
    const projectLoadError = useProjectStore((state) => state.projectLoadError);
    const retryProjectLoad = useProjectStore((state) => state.retryProjectLoad);
    const router = useRouter();
    useEditorProjectRoute(id);

    if (activeProjectId !== id) {
        if (projectLoadError?.projectId === id) {
            const label = projectLoadError.kind === 'not-found'
                ? 'Project not found'
                : 'Could not load project';
            return (
                <main className="flex min-h-screen items-center justify-center bg-gray-950 p-6 text-gray-100">
                    <section
                        role="alert"
                        className="w-full max-w-md rounded-lg border border-amber-500/30 bg-gray-900 p-6 shadow-xl"
                    >
                        <div className="flex items-center gap-3 text-amber-300">
                            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
                            <h1 className="text-lg font-semibold">{label}</h1>
                        </div>
                        <p className="mt-3 text-sm text-gray-400">
                            Retry this project or return to the project dashboard.
                        </p>
                        <div className="mt-5 flex gap-3">
                            <button
                                type="button"
                                className="rounded bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-500"
                                onClick={() => void retryProjectLoad().catch(() => undefined)}
                            >
                                Retry
                            </button>
                            <button
                                type="button"
                                className="rounded bg-gray-700 px-4 py-2 text-sm font-medium hover:bg-gray-600"
                                onClick={() => router.push('/')}
                            >
                                Projects
                            </button>
                        </div>
                    </section>
                </main>
            );
        }

        return (
            <main
                role="status"
                className="flex min-h-screen items-center justify-center bg-gray-950 text-sm text-gray-300"
            >
                Loading project…
            </main>
        );
    }

    return <Editor />;
}
