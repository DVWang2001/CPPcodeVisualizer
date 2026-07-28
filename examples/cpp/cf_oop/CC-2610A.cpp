#include<iostream>
#include<cmath>
using namespace std;
class Point{
   double m_x,m_y;
public:
   Point(double x=0,double y=0):m_x(x),m_y(y){}
   Point operator+(const Point b)const{return Point(m_x+b.m_x,m_y+b.m_y);}
   Point operator*(double b)const{return Point(m_x*b,m_y*b);}
   Point operator/(double b)const{return operator*(1/b);}
   Point operator-(const Point &a)const{return operator+(a*(-1.));}
   operator double()const{return sqrt(m_x*m_x+m_y*m_y);}
   friend istream& operator>>(istream &is,Point&a);
   friend ostream& operator<<(ostream &os,const Point&a);
};
istream& operator>>(istream &is,Point&a){return is>>a.m_x>>a.m_y;}
ostream& operator<<(ostream &os,const Point&a){
   return os<<"("<<a.m_x<<","<<a.m_y<<")";
}

class Triangle{public:
   Point A,B,C;
};
istream& operator>>(istream &is,Triangle &t){return is>>t.A>>t.B>>t.C;}
ostream& operator<<(ostream &os,Triangle &t){
   Point G=(t.A+t.B+t.C)/3;
   double a=(double)(t.B-t.C);
   double b=(double)(t.C-t.A);
   double c=(double)(t.A-t.B);
   Point I=(t.A*a+t.B*b+t.C*c)/(a+b+c);
   os<<"G:"<<G<<endl;
   os<<"I:"<<I;
   return os;
}

int main(){
   Triangle tri;cin>>tri;
   cout<<tri<<endl;  //@ @guide uml:tri
   return 0;
}
