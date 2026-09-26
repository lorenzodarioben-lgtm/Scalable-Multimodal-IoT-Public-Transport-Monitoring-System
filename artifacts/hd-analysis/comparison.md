# REVIEWED AWS HD EVIDENCE

All three valid repeats are shown; invalid/aborted attempts remain in the artifact directory and are listed in aggregate.json. Mean changes are descriptive, not significance claims. Positive changes are increases.

## PREDICTABLE_RAMP

| Metric | Reactive r1/r2/r3 | Mean ± sample SD | Hybrid r1/r2/r3 | Mean ± sample SD | Change in mean |
|---|---:|---:|---:|---:|---:|
| offeredJobsPerSecond | 26.185, 26.189, 26.157 | 26.177 ± 0.017 | 26.032, 25.993, 26.14 | 26.055 ± 0.076 | -0.5% |
| completedJobs | 16500, 16500, 16500 | 16500 ± 0 | 16500, 16500, 16500 | 16500 ± 0 | 0% |
| scaleRequestLatencySeconds | 88.749, 86.589, 76.312 | 83.883 ± 6.645 | -45.872, -76.3, -61.604 | -61.259 ± 15.217 | -173% |
| proactiveLeadSeconds | 0, 0, 0 | 0 ± 0 | 45.872, 76.3, 61.604 | 61.259 ± 15.217 | NA |
| requestToFirstRunningSeconds | 30.041, 21.704, 20.06 | 23.935 ± 5.351 | 24.159, 38.996, 18.404 | 27.186 ± 10.625 | 13.6% |
| requestToFirstReadySeconds | 32.434, 24.097, 22.778 | 26.436 ± 5.236 | 26.641, 41.468, 20.986 | 29.698 ± 10.578 | 12.3% |
| peakVisibleBacklog | 828, 1001, 910 | 913 ± 86.539 | 63, 48, 44 | 51.667 ± 10.017 | -94.3% |
| peakBacklogPerTask | 728, 911, 750 | 796.333 ± 99.912 | 40, 44, 45 | 43 ± 2.646 | -94.6% |
| peakOldestMessageAgeSeconds | 29, 32, 39 | 33.333 ± 5.132 | 17, 25, 18 | 20 ± 4.359 | -40% |
| completionThroughputJobsPerSecond | 25.59, 25.57, 26.11 | 25.757 ± 0.306 | 26.01, 25.42, 25.59 | 25.673 ± 0.304 | -0.3% |
| drainSeconds | 12.67, 12.34, 0 | 8.337 ± 7.222 | 0, 13.93, 12.43 | 8.787 ± 7.646 | 5.4% |
| processingP50Ms | 50, 51, 51 | 50.667 ± 0.577 | 51, 51, 50 | 50.667 ± 0.577 | 0% |
| processingP95Ms | 52, 53, 52 | 52.333 ± 0.577 | 54, 53, 52 | 53 ± 1 | 1.3% |
| peakRunningTasks | 4, 5, 5 | 4.667 ± 0.577 | 5, 5, 3 | 4.333 ± 1.155 | -7.2% |
| taskSeconds | 600, 630.692, 671.164 | 633.952 ± 35.694 | 1139.196, 1170.271, 857.978 | 1055.815 ± 172.035 | 66.5% |
| predictionMaeJobsPerSecond | NA, NA, NA | NA | 8.816, 8.914, 8.459 | 8.73 ± 0.239 | NA |
| predictionBiasJobsPerSecond | NA, NA, NA | NA | -1.157, -1.285, -2.045 | -1.496 ± 0.48 | NA |
| falseProactiveScaleOuts | 0, 0, 0 | 0 ± 0 | 0, 0, 0 | 0 ± 0 | NA |
| errors | 0, 0, 0 | 0 ± 0 | 0, 0, 0 | 0 ± 0 | NA |
| duplicates | 0, 0, 0 | 0 ± 0 | 0, 0, 0 | 0 ± 0 | NA |
| duplicateJobsSkipped | 0, 0, 0 | 0 ± 0 | 0, 0, 0 | 0 ± 0 | NA |
| dlq | 0, 0, 0 | 0 ± 0 | 0, 0, 0 | 0 ± 0 | NA |
| unaccountedJobs | 0, 0, 0 | 0 ± 0 | 0, 0, 0 | 0 ± 0 | NA |

## SUDDEN_BURST

| Metric | Reactive r1/r2/r3 | Mean ± sample SD | Hybrid r1/r2/r3 | Mean ± sample SD | Change in mean |
|---|---:|---:|---:|---:|---:|
| offeredJobsPerSecond | 29.035, 29.236, 29.238 | 29.17 ± 0.117 | 29.213, 29.233, 29.211 | 29.219 ± 0.012 | 0.2% |
| completedJobs | 18300, 18300, 18300 | 18300 ± 0 | 18300, 18300, 18300 | 18300 ± 0 | 0% |
| scaleRequestLatencySeconds | 110.642, 99.303, 92.686 | 100.877 ± 9.081 | 23.313, 24.636, 23.336 | 23.762 ± 0.757 | -76.4% |
| proactiveLeadSeconds | 0, 0, 0 | 0 ± 0 | 0, 0, 0 | 0 ± 0 | NA |
| requestToFirstRunningSeconds | 21.042, 22.596, 26.873 | 23.504 ± 3.02 | 21.3, 24.578, 23.58 | 23.153 ± 1.68 | -1.5% |
| requestToFirstReadySeconds | 23.528, 25.144, 29.326 | 25.999 ± 2.992 | 23.789, 27.028, 27.328 | 26.048 ± 1.962 | 0.2% |
| peakVisibleBacklog | 790, 1142, 706 | 879.333 ± 231.321 | 460, 352, 484 | 432 ± 70.314 | -50.9% |
| peakBacklogPerTask | 691, 932, 676 | 766.333 ± 143.667 | 112.5, 262, 294 | 222.833 ± 96.882 | -70.9% |
| peakOldestMessageAgeSeconds | 30, 45, 31 | 35.333 ± 8.386 | 29, 16, 25 | 23.333 ± 6.658 | -34% |
| completionThroughputJobsPerSecond | 28.41, 28.98, 28.97 | 28.787 ± 0.326 | 28.97, 28.41, 28.41 | 28.597 ± 0.323 | -0.7% |
| drainSeconds | 12.44, 0, 0 | 4.147 ± 7.182 | 0, 12.64, 12.37 | 8.337 ± 7.221 | 101% |
| processingP50Ms | 50, 51, 51 | 50.667 ± 0.577 | 51, 51, 51 | 51 ± 0 | 0.7% |
| processingP95Ms | 52, 53, 52 | 52.333 ± 0.577 | 53, 53, 54 | 53.333 ± 0.577 | 1.9% |
| peakRunningTasks | 5, 5, 5 | 5 ± 0 | 5, 5, 5 | 5 ± 0 | 0% |
| taskSeconds | 1729.254, 1759.066, 1791.592 | 1759.971 ± 31.179 | 2071.156, 2062.576, 2069.368 | 2067.7 ± 4.527 | 17.5% |
| predictionMaeJobsPerSecond | NA, NA, NA | NA | 24.409, 21.734, 21.266 | 22.47 ± 1.696 | NA |
| predictionBiasJobsPerSecond | NA, NA, NA | NA | 6.387, 6.306, 6.117 | 6.27 ± 0.139 | NA |
| falseProactiveScaleOuts | 0, 0, 0 | 0 ± 0 | 0, 0, 0 | 0 ± 0 | NA |
| errors | 0, 0, 0 | 0 ± 0 | 0, 0, 0 | 0 ± 0 | NA |
| duplicates | 0, 0, 0 | 0 ± 0 | 0, 0, 0 | 0 ± 0 | NA |
| duplicateJobsSkipped | 0, 0, 0 | 0 ± 0 | 0, 0, 0 | 0 ± 0 | NA |
| dlq | 0, 0, 0 | 0 ± 0 | 0, 0, 0 | 0 ± 0 | NA |
| unaccountedJobs | 0, 0, 0 | 0 ± 0 | 0, 0, 0 | 0 ± 0 | NA |

Task-seconds approximate relative worker use, not complete AWS billing. CloudWatch backlog values are genuine historical datapoints.