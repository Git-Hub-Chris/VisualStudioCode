FROM mcr.microsoft.com/devcontainers/base:ubuntu@sha256:c1613dbcdafe28e4b36ede9f3cb84a96e76765f50b3aeee87cb589eeb4c6dbca
MAINTAINER Microsoft

RUN apt-get install -y software-properties-common python
RUN add-apt-repository ppa:chris-lea/node.js
RUN echo "deb http://us.archive.ubuntu.com/ubuntu/ precise universe" >> /etc/apt/sources.list
RUN apt-get update
RUN apt-get install -y nodejs
#RUN apt-get install -y nodejs=0.6.12~dfsg1-1ubuntu1
RUN mkdir /var/www

ADD app.js /var/www/app.js

CMD ["/usr/bin/node", "/var/www/app.js"]
