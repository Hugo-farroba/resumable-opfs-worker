"use client";

import dynamic from "next/dynamic";

const DownloadPage = dynamic(() => import("./DownloadPage"), { ssr: false });

export default function Page() {
  return <DownloadPage />;
}
