import { ManagedEditorRoute } from './ManagedEditorRoute';

export default async function ManagedEditorPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  return <ManagedEditorRoute sessionId={sessionId} />;
}
