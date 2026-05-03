import { Construct } from 'constructs';

export interface PodEfsAccessPointProps {
  // Phase 7: filesystem, podName, allocated POSIX UID (from registry).
  readonly placeholder?: never;
}

/**
 * Per-pod EFS access point (POSIX UID-isolated, root path /pods/<podName>).
 * Created at pod-up time; retained on pod-down by default.
 */
export class PodEfsAccessPoint extends Construct {
  constructor(scope: Construct, id: string, props?: PodEfsAccessPointProps) {
    super(scope, id);
    void props;
  }
}
