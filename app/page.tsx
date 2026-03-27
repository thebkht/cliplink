import { Suspense } from "react";

import CliplinkApp from "@/components/cliplink-app";

export default function Home() {
  return (
    <Suspense fallback={null}>
      <CliplinkApp />
    </Suspense>
  );
}
