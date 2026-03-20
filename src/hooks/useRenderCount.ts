import { useEffect, useRef } from "react";

export function useRenderCount(name: string) {
  const count = useRef(0);

  useEffect(() => {
    count.current += 1;
    console.log(`[render] ${name}: ${count.current}`);
  });
}
