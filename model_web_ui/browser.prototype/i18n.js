export const translations = {
  en: {
    page_title: 'Apex Local Cut · Local Video Clipping Workspace',
    skip_link: 'Skip to workspace',
    brand_secondary: '· Local Video Clipping Workspace',
    nav_analysis: 'Analysis Queue',
    nav_review: 'Clip Review',
    nav_exports: 'Export Tasks',
    session_notice: 'Tasks persist in current page only · Re-import after refresh or close',
    lang_toggle: '中文',
    lang_toggle_aria: 'Switch language to Chinese',

    // Analysis page
    status_ready: 'Workspace ready',
    page_heading: 'Video Workspace',
    page_intro: 'Find clips worth keeping from full match recordings.',
    local_note: 'Recordings stay on device',
    queue_heading: 'Analysis Queue',
    queue_count: '{count} recordings',
    import_files: '＋ Import Videos',
    drop_zone_aria: 'Drop local video files here',
    queue_summary_waiting: 'Waiting for imported videos',
    queue_footer_right: 'Supports multiple files · Auto queued',
    queue_summary_analyzing: '{analyzing} analyzing · {waiting} queued',
    queue_summary_idle: 'No videos currently analyzing. You can review clips or import new videos.',
    queue_summary_empty: 'Automatic analysis starts after importing; candidates appear progressively.',
    queue_summary_failed: 'No reviewable videos currently. Please retry or import other recordings.',
    empty_drop_title: 'Drop videos here',
    empty_drop_desc: 'Or click "Import Videos" to select multiple files.',
    empty_drop_types: 'Supports MP4, MKV, WebM, MOV, etc.',

    // Workflow guide
    workflow_heading: 'Workflow · Analyze & Review in Parallel',
    step1_title: 'Automatic analysis after import',
    step1_desc: 'Gunshot candidates appear progressively as analysis proceeds.',
    step2_title: 'Review footage anytime',
    step2_desc: 'Browse the original video, retain clips, and adjust boundaries.',
    step3_title: 'Submit export when ready',
    step3_desc: 'Each clip is rendered independently while review continues.',
    demo_btn: 'Try 1-Min Real Combat Sample',
    demo_note: 'From actual Apex gameplay to test analysis, clipping, and export.',

    // Settings
    settings_heading: 'Analysis Settings & Runtime Logs',
    model_label: 'Model for new tasks',
    model_note: 'Model selection only affects new tasks. Gunshot candidates retain 5 seconds before and after; overlapping, adjacent, or gaps <= 5s merge into one segment. Detection uses the default decodable audio track without judging game sounds; preview and export preserve original audio.',
    session_storage_note: 'Tasks persist only within the current page. Please finish exporting and saving videos before refresh or close; reopening requires re-importing.',
    download_report: 'Download Analysis Report',

    // Review page
    back_to_analysis: 'Back to analysis queue',
    review_heading: 'Clip Review',
    select_recording_aria: 'Currently reviewed recording',
    player_panel_aria: 'Source playback & timeline',
    source_canvas_aria: 'Original video frame',
    player_select_hint: 'Select recording to start review',
    play: 'Play',
    pause: 'Pause',
    play_pause_title: 'Play / Pause (Space)',
    audition_clip: 'Audition Clip',
    audition_clip_title: 'Play from clip start, pause at end (Shift+Space)',
    prev_candidate: '← Previous Clip',
    prev_candidate_title: 'Previous Clip ([)',
    next_candidate: 'Next Clip →',
    next_candidate_title: 'Next Clip (])',
    volume_aria: 'Audition volume',
    mute_title: 'Mute (M)',
    unmute_title: 'Unmute (M)',
    fullscreen_title: 'Fullscreen (F)',
    exit_fullscreen_title: 'Exit Fullscreen (F)',

    // Timeline
    timeline_heading: 'Source Timeline',
    timeline_area_aria: 'Source timeline workspace',
    click_to_adjust: 'Click a predicted candidate below to start adjusting',
    fit_all: 'Fit All',
    full_view: 'Full View',
    source_head_title: 'Drag to seek; Arrow keys to fine-tune, Shift to accelerate',
    source_head_aria: 'Source playback position',
    handle_left_aria: 'Adjust clip start',
    handle_right_aria: 'Adjust clip end',
    full_overview: 'Full Overview',
    overview_aria: 'Full playback position',
    hover_sample_alt: 'Source preview frame',
    hover_sample_text: 'Source preview frame',

    // Precise editor
    precise_editor_summary: 'Precision Trimming & Local View',
    range_heading: 'Current Clip Range',
    fit_selection: 'Zoom to Clip',
    range_select_hint: 'Select candidate or add manual range',
    range_start_label: 'Start / s',
    range_end_label: 'End / s',
    set_current_start: 'Set current as start',
    set_current_end: 'Set current as end',
    local_view_summary: 'Local View & Cut Point Notes',
    zoom_start_label: 'View start / s',
    zoom_end_label: 'View end / s',
    cut_point_note: 'Adjusting boundaries does not move playback position. Requested ranges are shown here; actual exported boundaries may be constrained by codec and keyframes.',

    // Prediction workspace
    exclude_btn: 'Exclude Selected · Del',
    undo_btn: 'Undo',
    redo_btn: 'Redo',
    show_excluded: 'Show excluded',
    zoom_out: 'Zoom Out',
    zoom_in: 'Zoom In',
    prediction_heading: 'Predicted Intervals',
    wave_aria: 'Audio waveform, click to seek; generated progressively with analysis',
    prediction_intervals_aria: 'Predicted intervals, click to select',
    export_note: 'Submitting locks the current batch; further edits apply to subsequent batches.',
    export_format_label: 'Export format',
    view_exports: 'View Export Tasks',
    submit_export: 'Submit Clips for Export',
    list_toolbar_summary: 'Clip List & Batch Actions',
    add_manual: '＋ Add at Current Time',
    select_all: 'Select All',
    deselect_all: 'Deselect All',
    filter_rules_summary: 'Filter & Clipping Rules',
    threshold_label: 'Gunshot threshold',
    recompute_filter: 'Recompute Filter',
    rules_note: 'Standard stable candidates are selected by default; supplemental suggestions are unselected by default. Checkboxes do not imply verified highlights. Batch actions preserve trims and skip unfinished candidates. Filtering uses existing prediction scores while preserving manual decisions.',
    reset_decisions: 'Reset Manual Decisions',

    // Exports section
    exports_heading: 'Export Tasks',
    export_count: '{count} batches',
    choose_directory: 'Choose Output Folder',
    change_directory: 'Change Output Folder',
    output_dir_hint: 'Please choose an output folder on first export; subsequent batches in this session will reuse it.',
    output_dir_next: 'Output folder for upcoming batches: {name}',
    output_specs_summary: 'Output Specs & Saving Notes',
    output_specs_p1: 'Each clip is exported individually as {format}, with audio from the source default track. Resolution and frame rate are preserved; re-encoding is not lossless. Exports execute once analysis frees up resources, during which review can continue.',
    output_specs_p2: 'Clips stream directly into the chosen folder and are marked saved once write streams close successfully. For large batches, pick a mounted external drive folder with sufficient space. Desktop Chrome or Edge is recommended.',
    footer_tag: 'Apex Local Cut · Local Video Clipping Workspace',
    footer_disclaimer: 'Gunshot candidates do not imply player shots, hits, or kills.',

    // Dynamic runtime texts
    status_preparing: 'Preparing',
    status_queued: 'Queued',
    status_analyzing: 'Analyzing',
    status_completed: 'Completed',
    status_stopped: 'Stopped',
    status_failed: 'Failed',
    status_interrupted: 'Interrupted',

    batch_awaiting_dir: 'Waiting for output folder',
    batch_queued: 'Queued',
    batch_running: 'Exporting',
    batch_completed: 'Saved',
    batch_cancelled: 'Cancelled',
    batch_failed: 'Export failed',
    batch_interrupted: 'Interrupted, pending execution',

    outcome_not_started: 'Not started',
    outcome_running: 'Exporting',
    outcome_completed: 'Completed',
    outcome_failed: 'Failed',
    outcome_cancelled: 'Cancelled',
    outcome_interrupted: 'Interrupted, completion unconfirmed',

    action_review_count: 'Review {count} clips',
    action_browse_source: 'Browse Footage',
    action_stop: 'Stop Analysis',
    action_remove_queue: 'Remove from Queue',
    action_retry: 'Retry from Start',
    action_reanalyze: 'Re-analyze',

    clip_excluded_badge: 'Excluded',
    clip_excluded_desc: 'Excluded',
    clip_provisional_desc: 'Completing...',
    clip_supplemental_desc: 'Supplemental · Overlaps with manual decision',
    clip_manual_desc: 'Manual Clip',
    clip_candidate_desc: 'Reviewable Candidate',
    clip_editing_btn: 'Editing',
    clip_locate_btn: 'Locate & Trim',
    clip_restore_btn: 'Restore',
    clip_exclude_btn: 'Exclude',
    clip_empty_excluded: 'Clips are excluded. Check "Show excluded" to view and restore.',
    clip_empty_filtered: 'No candidates under current filter rules; manual ranges can be added.',
    clip_empty_analyzing: 'Candidates will appear as analysis proceeds; you can browse footage or add manual ranges.',

    volume_muted: 'Muted',
    frame_text: 'frame',
    audio_decoder: 'AudioDecoder',
    video_decoder: 'VideoDecoder',
    isolated_context: 'Isolation',
    cap_available: 'available',
    cap_unavailable: 'unavailable',

    source_analyzed_until: 'Analyzed to {time}',
    source_clips_count: '{count} confirmed ranges',
    review_progress_text: '{name} · Analyzed to {current} / {total} · {status}{analyzing}',
    analyzing_ongoing: ', analysis ongoing',
    new_candidates_badge: '+{count} new',
    tail_analyzing: 'Reached end of current candidates; analysis still in progress. Footage is fully browseable.',
    tail_done: 'Reached end of candidates list.',
    selection_summary_text: '{count} clips selected · {duration}s total{unexported}',
    unexported_changes_tag: ' · Unexported selections pending',

    batch_empty: 'No export tasks yet.',
    batch_view_files: 'View clip files · {count}',
    batch_ranges_info: 'Submitted at {time} · Fixed ranges: {ranges} · {format} / {video} + {audio} · Source default audio',
    batch_title_text: '{name} · {count} clips',
    batch_dest_dir: 'Save folder: {name}',
    batch_dest_awaiting: 'Save folder: Waiting for selection',
    batch_dest_unrecorded: 'Save folder: Not recorded',
    batch_dest_pending: ' · Resume destination: {name} (see clip list for details)',
    batch_cancel_btn: 'Cancel Batch',
    batch_start_btn: 'Choose Folder & Continue',
    batch_resume_link_btn: 'Link Source & Continue',
    batch_back_review_btn: 'Back to Clips',
    batch_detail_summary: 'Export Details',
    batch_summary_awaiting: '{summary} · Remaining clips waiting for output folder',

    output_item_saved: '{name} · Saved to {dest}',
    output_item_unverified: '; file usability unverified',
    output_item_check_error: 'File saved; secondary verification incomplete: {err}',
    output_item_details_summary: '{size} MiB · File details',
    output_item_meta: '{reused}{size} MiB · Requested {duration}s{measured} · Actual start/end unchecked',
    output_item_reused: 'Reused existing cut · ',
    output_item_readback: ' · Measured {duration}s',
    output_item_readback_incomplete: ' · Readback incomplete',

    nav_exports_badge: 'Export Tasks · {count}',

    output_format_render: '{format} ({video} + {audio}) at original resolution and frame rate',

    // Alerts / Notes
    note_demo_loading: 'Loading 1-minute real combat sample...',
    note_demo_ready: '1-minute real combat sample imported. You can review clips anytime.',
    note_export_submitted: 'Export submitted. Files will be saved directly to the chosen folder. Review can continue.',
    note_prep_files: 'Preparing {count} recordings; each analyzes independently once ready.',
    note_files_added: 'Recordings added · Review anytime',
    note_file_exists: '{name} is already in the workspace.',
    note_import_failed: 'The following files failed to import: {list}. Ready recordings continue.',
    note_no_earlier_candidate: 'No earlier candidates; continue browsing footage.',
    note_no_later_candidate: 'No later candidates; continue browsing footage.',
    note_tail_analyzing: 'Reached end of current candidates; analysis still in progress.',
    note_recompute_done: 'Filter recomputed with existing scores; manual trims and exclusions preserved.',
    confirm_reset_decisions: 'Reset manual selections for "{name}"? Default selections will be restored, and manual trims, ranges, and exclusions will be cleared. Submitted export batches are kept.',
    err_dir_secure: 'Directory export requires a secure context. Please open the page via HTTPS or localhost.',
    err_dir_support: 'This browser does not support directory export. Please use desktop Chrome or Edge.',
    err_dir_permission: 'Folder write permission not granted. Please re-select and allow permissions.',
    err_select_video_first: 'Please select a video to export first.',
    err_no_source_record: 'No source recording available in current page. Please import first.',
    err_no_clips_selected: 'No confirmed clips selected for export.',
    err_no_batch_source: 'Source recording for this task is not in current page.',
    err_dir_permission_lost: 'Output folder write permission unavailable. Click "Choose Folder & Continue" to re-select.',
    err_dir_aborted: 'Output folder not chosen yet; clips are preserved. Click "Choose Folder & Continue" to retry.',
    err_demo_not_found: 'Real combat sample is not configured or disk is unavailable. Use "Import Videos" to select local footage.',
    err_demo_too_large: 'Demo sample must be smaller than 100 MiB; for larger recordings use "Import Videos".',
    err_demo_read: 'Unable to read real sample; check disk mount and retry.',
    err_demo_corrupted: 'Sample file modified or incomplete; please retry.',
    err_valid_trim_time: 'Please enter a valid cut time.',
    err_no_dir_picker: 'Output folder not acquired. If dialog did not appear, open in desktop Chrome and retry.'
  },
  zh: {
    page_title: 'Apex Local Cut · 本地选片工作区',
    skip_link: '跳到工作区',
    brand_secondary: '· 本地选片工作区',
    nav_analysis: '分析队列',
    nav_review: '片段复核',
    nav_exports: '导出任务',
    session_notice: '任务仅在当前页面保留 · 刷新或关闭后需重新导入',
    lang_toggle: 'English',
    lang_toggle_aria: 'Switch language to English / 切换为英文',

    // Analysis page
    status_ready: '工作区已就绪',
    page_heading: '录像工作区',
    page_intro: '从整场对局，找到值得留下的片段。',
    local_note: '录像留在本机',
    queue_heading: '分析队列',
    queue_count: '{count} 份录像',
    import_files: '＋ 导入录像',
    drop_zone_aria: '拖入本地录像',
    queue_summary_waiting: '等待导入录像',
    queue_footer_right: '支持多文件 · 自动排队',
    queue_summary_analyzing: '{analyzing} 份分析中 · {waiting} 份待分析',
    queue_summary_idle: '当前没有正在分析的录像，可进入复核或导入新录像。',
    queue_summary_empty: '导入录像后自动分析，候选随进度逐步出现。',
    queue_summary_failed: '暂无可复核录像，请重试或导入其他录像。',
    empty_drop_title: '把录像拖到这里',
    empty_drop_desc: '也可以点击「导入录像」，一次选择多份文件。',
    empty_drop_types: '支持 MP4、MKV、WebM、MOV 等录像格式',

    // Workflow guide
    workflow_heading: '使用说明 · 分析与复核同时推进',
    step1_title: '导入后自动分析',
    step1_desc: '枪声候选随分析逐步出现。',
    step2_title: '随时开始选片',
    step2_desc: '浏览原片，保留片段、调整范围。',
    step3_title: '选好即可提交导出',
    step3_desc: '每段独立成片，期间可继续复核。',
    demo_btn: '试用 1 分钟真实交战',
    demo_note: '来自实际 Apex 对局，体验分析、选片与导出。',

    // Settings
    settings_heading: '分析设置与运行记录',
    model_label: '新任务模型',
    model_note: '模型仅影响新任务。枪声候选前后各保留 5 秒，扩展后重叠、相接或间隔不超过 5 秒的范围合并为一段。检测自动使用默认且可解码的音轨，不判断是否为游戏声音；预览和导出沿用原片默认声音。',
    session_storage_note: '任务仅在当前页面保留。请在刷新或关闭前完成导出并保存视频；重新打开需重新导入录像。',
    download_report: '下载当前录像分析报告',

    // Review page
    back_to_analysis: '返回分析队列',
    review_heading: '片段复核',
    select_recording_aria: '正在复核的录像',
    player_panel_aria: '原片播放与时间轴',
    source_canvas_aria: '原录像画面',
    player_select_hint: '选择录像开始复核',
    play: '播放',
    pause: '暂停',
    play_pause_title: '播放 / 暂停 (Space)',
    audition_clip: '试听选片',
    audition_clip_title: '从当前选片起点播放，到终点自动暂停 (Shift+Space)',
    prev_candidate: '← 上一候选',
    prev_candidate_title: '上一候选 ([)',
    next_candidate: '下一候选 →',
    next_candidate_title: '下一候选 (])',
    volume_aria: '试听音量',
    mute_title: '静音 (M)',
    unmute_title: '取消静音 (M)',
    fullscreen_title: '全屏 (F)',
    exit_fullscreen_title: '退出全屏 (F)',

    // Timeline
    timeline_heading: '原片时间轴',
    timeline_area_aria: '原片时间轴工作区',
    click_to_adjust: '点击下方预测范围开始调整',
    fit_all: '全片',
    full_view: '全片视野',
    source_head_title: '拖动定位；方向键微调，Shift 加速',
    source_head_aria: '原录像播放位置',
    handle_left_aria: '调整选片起点',
    handle_right_aria: '调整选片终点',
    full_overview: '整片定位',
    overview_aria: '整片播放位置',
    hover_sample_alt: '附近原片抽样画面',
    hover_sample_text: '原片参考画面',

    // Precise editor
    precise_editor_summary: '精确切点与局部视野',
    range_heading: '当前选片范围',
    fit_selection: '放大至选片',
    range_select_hint: '选择候选或添加手动范围',
    range_start_label: '起点 / 秒',
    range_end_label: '终点 / 秒',
    set_current_start: '当前位置设为起点',
    set_current_end: '当前位置设为终点',
    local_view_summary: '局部视野与切点说明',
    zoom_start_label: '视野起点 / 秒',
    zoom_end_label: '视野终点 / 秒',
    cut_point_note: '调整范围不会移动播放位置。这里记录请求范围，实际导出边界可能受编码和包边界影响。',

    // Prediction workspace
    exclude_btn: '排除选中 · Del',
    undo_btn: '撤销',
    redo_btn: '重做',
    show_excluded: '显示已排除',
    zoom_out: '缩小',
    zoom_in: '放大',
    prediction_heading: '预测区间',
    wave_aria: '分析音轨波形，点击定位；随分析逐步生成',
    prediction_intervals_aria: '预测区间，点击选择',
    export_note: '提交后固定本批范围，后续修改用于下一批。',
    export_format_label: '导出格式',
    view_exports: '查看导出任务',
    submit_export: '提交选片导出',
    list_toolbar_summary: '列表与批量操作',
    add_manual: '＋ 添加当前位置',
    select_all: '全选',
    deselect_all: '全不选',
    filter_rules_summary: '筛选与选片规则',
    threshold_label: '枪声阈值',
    recompute_filter: '调整筛选',
    rules_note: '普通稳定候选默认选中，补充建议默认不选；勾选不表示已经看过或确认精彩。批量操作保留裁边，跳过尚未收尾的候选。筛选使用已有预测分数，保留人工决定。',
    reset_decisions: '重置人工选片',

    // Exports section
    exports_heading: '导出任务',
    export_count: '{count} 个批次',
    choose_directory: '选择输出目录',
    change_directory: '更换输出目录',
    output_dir_hint: '首次导出请选择输出目录，本页面后续批次沿用该目录。',
    output_dir_next: '后续批次输出目录：{name}',
    output_specs_summary: '输出规格与保存说明',
    output_specs_p1: '每段独立导出为{format}，声音沿用原片默认音轨。保留分辨率与帧率，重新编码不等于无损。分析释放资源后执行导出，期间可继续复核。',
    output_specs_p2: '成片直接写入所选目录，写入流成功关闭后显示已保存。大批次请选择已挂载且空间充足的外接盘目录，浏览器不能验证挂载身份。建议使用桌面 Chrome 或 Edge。',
    footer_tag: 'Apex Local Cut · 本地选片',
    footer_disclaimer: '枪声候选不代表本人开枪、命中或击杀。',

    // Dynamic runtime texts
    status_preparing: '正在准备',
    status_queued: '排队中',
    status_analyzing: '分析中',
    status_completed: '分析完成',
    status_stopped: '已停止',
    status_failed: '失败',
    status_interrupted: '已中断',

    batch_awaiting_dir: '等待输出目录',
    batch_queued: '排队中',
    batch_running: '正在导出',
    batch_completed: '已保存',
    batch_cancelled: '已取消',
    batch_failed: '导出失败',
    batch_interrupted: '已中断，尚未继续执行',

    outcome_not_started: '未开始',
    outcome_running: '正在导出',
    outcome_completed: '已完成',
    outcome_failed: '失败',
    outcome_cancelled: '已取消',
    outcome_interrupted: '已中断，完成情况未确认',

    action_review_count: '复核 {count} 段',
    action_browse_source: '浏览原片',
    action_stop: '停止分析',
    action_remove_queue: '移出队列',
    action_retry: '从头重试',
    action_reanalyze: '重新分析',

    clip_excluded_badge: '已排除',
    clip_excluded_desc: '已排除',
    clip_provisional_desc: '后续正在补全',
    clip_supplemental_desc: '补充建议 · 与人工决定重叠',
    clip_manual_desc: '人工选片',
    clip_candidate_desc: '可复核候选',
    clip_editing_btn: '当前编辑',
    clip_locate_btn: '定位与调整',
    clip_restore_btn: '恢复',
    clip_exclude_btn: '排除',
    clip_empty_excluded: '片段已排除，勾选“显示已排除”可查看并恢复。',
    clip_empty_filtered: '当前筛选条件下没有候选，可添加手动范围。',
    clip_empty_analyzing: '候选将随分析逐步出现，也可先浏览原片或添加手动范围。',

    volume_muted: '静音',
    frame_text: '画面',
    audio_decoder: '音频解码',
    video_decoder: '视频解码',
    isolated_context: '隔离上下文',
    cap_available: '可用',
    cap_unavailable: '不可用',

    source_analyzed_until: '已分析至 {time}',
    source_clips_count: '{count} 个确定范围',
    review_progress_text: '{name} · 已分析至 {current} / {total} · {status}{analyzing}',
    analyzing_ongoing: '，后续仍在分析',
    new_candidates_badge: '新增 {count} 段',
    tail_analyzing: '当前候选已到末尾，后续仍在分析。全片可继续浏览。',
    tail_done: '当前候选列表已到末尾。',
    selection_summary_text: '已选 {count} 段 · 共 {duration} 秒{unexported}',
    unexported_changes_tag: ' · 有选片尚未提交导出',

    batch_empty: '尚无导出任务。',
    batch_view_files: '查看成片文件 · {count} 个',
    batch_ranges_info: '提交于 {time} · 固定请求范围：{ranges} · {format} / {video} + {audio} · 原片默认声音',
    batch_title_text: '{name} · {count} 段',
    batch_dest_dir: '保存目录：{name}',
    batch_dest_awaiting: '保存目录：等待选择',
    batch_dest_unrecorded: '保存位置：未记录',
    batch_dest_pending: ' · 继续导出目录：{name}（各文件位置见成片记录）',
    batch_cancel_btn: '取消本批',
    batch_start_btn: '选择目录并继续',
    batch_resume_link_btn: '关联原录像后继续',
    batch_back_review_btn: '返回选片',
    batch_detail_summary: '导出详情',
    batch_summary_awaiting: '{summary} · 剩余片段等待选择输出目录',

    output_item_saved: '{name} · 已保存至 {dest}',
    output_item_unverified: '；当前未验证文件可用性',
    output_item_check_error: '文件已保存；附加检查未完成：{err}',
    output_item_details_summary: '{size} MiB · 文件详情',
    output_item_meta: '{reused}{size} MiB · 请求时长 {duration} 秒{measured} · 实际起止未校验',
    output_item_reused: '复用已有成片 · ',
    output_item_readback: ' · 读回时长 {duration} 秒',
    output_item_readback_incomplete: ' · 时长读回未完成',

    nav_exports_badge: '导出任务 · {count}',

    output_format_render: '原视频分辨率与帧率的 {format}（{video} + {audio}）',

    // Alerts / Notes
    note_demo_loading: '正在加载一分钟真实交战样本…',
    note_demo_ready: '已导入一分钟真实交战样本，可随时进入片段复核。',
    note_export_submitted: '已提交导出，文件将直接保存至所选目录。可以继续复核。',
    note_prep_files: '正在准备 {count} 份录像；每份就绪后独立进入分析。',
    note_files_added: '录像已加入 · 可随时复核',
    note_file_exists: '{name} 已在当前工作区中。',
    note_import_failed: '以下录像未能导入，可重新选择重试：{list}。其他就绪录像继续分析。',
    note_no_earlier_candidate: '没有更早的候选，可继续浏览原片。',
    note_no_later_candidate: '没有后续候选，可继续浏览原片。',
    note_tail_analyzing: '当前候选已到末尾，后续仍在分析。',
    note_recompute_done: '已用已有分数调整筛选，人工裁边和排除决定保留。',
    confirm_reset_decisions: '重置“{name}”的人工选片？将恢复默认勾选，并清除裁边、手动范围与排除记录；已提交导出批次保留。',
    err_dir_secure: '目录导出需要安全连接，请通过 HTTPS 或本机 localhost 打开页面。',
    err_dir_support: '此浏览器不支持目录导出，请使用支持目录选择和写入的浏览器，建议桌面 Chrome 或 Edge。',
    err_dir_permission: '未获得目录写入权限，请重新选择并允许写入。',
    err_select_video_first: '请先选择要导出的录像。',
    err_no_source_record: '当前页面没有可导出的原录像，请先导入录像。',
    err_no_clips_selected: '没有范围已确定且已选中的片段。',
    err_no_batch_source: '当前页面没有这批任务的原录像。',
    err_dir_permission_lost: '输出目录写入权限不可用，请点击「选择目录并继续」重新选择。',
    err_dir_aborted: '尚未选择输出目录，选片已保留。点击「选择目录并继续」即可重试。',
    err_demo_not_found: '真实样本尚未配置或所在磁盘不可用。请使用“导入录像”选择本地交战片段。',
    err_demo_too_large: '演示样本需小于 100 MiB；较大录像请使用“导入录像”。',
    err_demo_read: '无法读取真实样本，请确认样本所在磁盘已挂载后重试。',
    err_demo_corrupted: '样本文件已变化或读取不完整，请重试。',
    err_valid_trim_time: '请输入有效的切点时间',
    err_no_dir_picker: '尚未取得输出目录。若未弹出目录窗口，请在桌面 Chrome 中打开本页后选择。'
  }
};

const STORAGE_KEY = 'apex_local_cut_lang';
const listeners = new Set();

let currentLanguage = (() => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch (_) {}
  return 'en'; // Default English as requested
})();

export function getLang() {
  return currentLanguage;
}

export function setLang(lang) {
  if (lang !== 'en' && lang !== 'zh') return;
  currentLanguage = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch (_) {}
  applyTranslations();
  for (const listener of listeners) {
    try {
      listener(currentLanguage);
    } catch (e) {
      console.error(e);
    }
  }
}

export function onLanguageChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function t(key, params = {}) {
  const dict = translations[currentLanguage] || translations.en;
  let text = dict[key] || translations.en[key] || key;
  for (const [k, v] of Object.entries(params)) {
    text = text.replaceAll(`{${k}}`, v !== undefined && v !== null ? String(v) : '');
  }
  return text;
}

export function applyTranslations() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = currentLanguage === 'zh' ? 'zh-CN' : 'en';
  document.title = t('page_title');

  const elements = document.querySelectorAll('[data-i18n]');
  for (const el of elements) {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  }

  const titleElements = document.querySelectorAll('[data-i18n-title]');
  for (const el of titleElements) {
    const key = el.dataset.i18nTitle;
    if (key) el.title = t(key);
  }

  const ariaElements = document.querySelectorAll('[data-i18n-aria]');
  for (const el of ariaElements) {
    const key = el.dataset.i18nAria;
    if (key) el.setAttribute('aria-label', t(key));
  }

  const toggleBtn = document.getElementById('lang-toggle');
  if (toggleBtn) {
    toggleBtn.textContent = t('lang_toggle');
    toggleBtn.setAttribute('aria-label', t('lang_toggle_aria'));
  }
}
