/* First-use guide for the main CodeLeaf workflows. */
const CodeLeafWalkthrough = (() => {
  const STORAGE_KEY = 'codeleaf_walkthrough_v1';
  const steps = [
    {
      eyebrow: '01 / Workspace',
      title: 'A focused place to build and run',
      description: 'Sign in and enter the workspace to write code, explore data, and run experiments in one place.',
      points: [
        'Create and organize files, switch between editor tabs, and use language-aware editing tools.',
        'Run supported programming languages in the workspace, inspect output in the console, and keep useful snippets close by.',
        'Use the Explorer, search, command palette, and settings to shape your daily workflow.'
      ],
      actionLabel: 'Open workspace',
      action: () => Auth.require(() => showView('ide'))
    },
    {
      eyebrow: '02 / Data',
      title: 'Work with MongoDB and SQL data',
      description: 'Connect your data workflow to the query surface that fits the task, then inspect results without leaving the application.',
      points: [
        'Write MongoDB queries and inspect collections and schema details.',
        'Use SQL tools for relational data and see query results in the workspace console.',
        'Review query history and reuse saved snippets as you iterate.'
      ]
    },
    {
      eyebrow: '03 / Assessments',
      title: 'Create, host, and take exams',
      description: 'The Exam Portal supports both the mentor’s assessment workflow and the student’s participation flow.',
      points: [
        'Mentors create a room, prepare question papers, attach datasets or question media, and manage a live session.',
        'Students join with their room and identity details, answer questions, run coding examples, and submit work.',
        'Question types include programming, MongoDB/SQL queries, and multiple choice; available features depend on the room configuration.'
      ],
      actionLabel: 'Open exam portal',
      action: () => Auth.require(() => window.ExamPortal?.showRoleSelection())
    },
    {
      eyebrow: '04 / Meetings',
      title: 'Collaborate in a live meeting',
      description: 'Start or join a meeting to communicate and work together while keeping your workspace nearby.',
      points: [
        'Use the meeting room for live audio/video conversations and participant coordination.',
        'Share the workspace context with collaborators and follow shared editor activity where available.',
        'Use meeting chat and the in-call controls to stay aligned during a session.'
      ],
      actionLabel: 'Open meetings',
      action: () => Auth.require(() => window.MeetingRoom?.toggleMeeting())
    },
    {
      eyebrow: '05 / AI & productivity',
      title: 'Move from a question to a clearer next step',
      description: 'CodeLeaf includes assistance and organization tools that help you understand and refine your work.',
      points: [
        'Open the CodeLeaf AI assistant for code review, explanations, and optimization prompts.',
        'Use snippets, search, and history to find previous work and repeat common tasks.',
        'Adjust editor and execution preferences from settings.'
      ]
    },
    {
      eyebrow: '06 / Your next step',
      title: 'Choose a workflow and get started',
      description: 'Whether you are learning, building, teaching, or collaborating, start with one surface and return to the guide whenever you need it.',
      points: [
        'Build or practice in the workspace.',
        'Host or join an assessment through the Exam Portal.',
        'Start a meeting when you want to collaborate live.'
      ],
      actionLabel: 'Enter workspace',
      action: () => Auth.require(() => showView('ide'))
    }
  ];

  let currentStep = 0;
  let returnFocus = null;

  function element(id) { return document.getElementById(id); }

  function completedForCurrentAccount() {
    try {
      const key = typeof accountStorageKey === 'function'
        ? accountStorageKey(STORAGE_KEY)
        : `${STORAGE_KEY}:${window.Auth?.user?.id || 'guest'}`;
      return localStorage.getItem(key) === 'done';
    } catch (error) {
      console.warn('Unable to read walkthrough preference:', error);
      return false;
    }
  }

  function markCompleted() {
    try {
      const key = typeof accountStorageKey === 'function'
        ? accountStorageKey(STORAGE_KEY)
        : `${STORAGE_KEY}:${window.Auth?.user?.id || 'guest'}`;
      localStorage.setItem(key, 'done');
    } catch (error) {
      console.warn('Unable to save walkthrough preference:', error);
    }
  }

  function render() {
    const step = steps[currentStep];
    element('walkthrough-eyebrow').textContent = step.eyebrow;
    element('walkthrough-title').textContent = step.title;
    element('walkthrough-description').textContent = step.description;
    element('walkthrough-step-count').textContent = `Step ${currentStep + 1} of ${steps.length}`;

    const points = element('walkthrough-points');
    points.replaceChildren(...step.points.map(text => {
      const item = document.createElement('li');
      item.textContent = text;
      return item;
    }));

    const progress = element('walkthrough-progress');
    progress.replaceChildren(...steps.map((_, index) => {
      const marker = document.createElement('span');
      if (index <= currentStep) marker.classList.add('active');
      return marker;
    }));

    element('walkthrough-back').disabled = currentStep === 0;
    element('walkthrough-next').textContent = currentStep === steps.length - 1 ? 'Finish' : 'Next';
    const action = element('walkthrough-step-action');
    action.hidden = !step.actionLabel;
    action.textContent = step.actionLabel || '';
  }

  function close(markDone = true) {
    const overlay = element('codeleaf-walkthrough');
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    document.body.classList.remove('walkthrough-open');
    if (markDone) markCompleted();
    returnFocus?.focus?.();
  }

  function open() {
    const overlay = element('codeleaf-walkthrough');
    if (!overlay) return;
    returnFocus = document.activeElement;
    currentStep = 0;
    render();
    overlay.hidden = false;
    document.body.classList.add('walkthrough-open');
    element('walkthrough-close').focus();
  }

  function openAfterSignup() {
    if (completedForCurrentAccount()) return;
    window.setTimeout(() => {
      if (!completedForCurrentAccount()) open();
    }, 250);
  }

  function initialize() {
    element('walkthrough-close')?.addEventListener('click', () => close());
    element('walkthrough-skip')?.addEventListener('click', () => close());
    element('walkthrough-back')?.addEventListener('click', () => {
      if (currentStep > 0) { currentStep -= 1; render(); }
    });
    element('walkthrough-next')?.addEventListener('click', () => {
      if (currentStep < steps.length - 1) {
        currentStep += 1;
        render();
      } else {
        close();
      }
    });
    element('walkthrough-step-action')?.addEventListener('click', () => {
      const action = steps[currentStep].action;
      close();
      action?.();
    });
    element('codeleaf-walkthrough')?.addEventListener('click', event => {
      if (event.target === element('codeleaf-walkthrough')) close();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !element('codeleaf-walkthrough')?.hidden) close();
    });
    window.addEventListener('codeleaf:account-created', openAfterSignup);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }

  return { open };
})();

window.CodeLeafWalkthrough = CodeLeafWalkthrough;
