import { useEffect, useState } from "react";
import { calcSkeletonRows } from "../utils/layoutMetrics";

// Recompute the skeleton row count on resize so the loading state keeps
// filling the list area after a window size change.
export function useSkeletonRows(): number {
  const [skeletonRows, setSkeletonRows] = useState(calcSkeletonRows);
  useEffect(() => {
    const onResize = () => {
      setSkeletonRows(calcSkeletonRows());
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);
  return skeletonRows;
}
